use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Cursor, Read},
    path::{Path, PathBuf},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::Builder as TempDirBuilder;
use zip::ZipArchive;

const MAX_PACKAGE_SIZE: usize = 50 * 1024 * 1024;
const MAX_FILE_COUNT: usize = 2_000;
const MAX_UNCOMPRESSED_SIZE: u64 = 200 * 1024 * 1024;
const MAX_SKILL_MD_SIZE: u64 = 1024 * 1024;
const INSTALL_METADATA_FILE: &str = ".kocotree-skill.json";
const MANAGER_STATE_FILE: &str = ".kocotree-skills-desktop.json";
const MANAGED_COPY_METADATA_FILE: &str = ".kocotree-managed-copy.json";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSkillInput {
    pub skill_id: String,
    pub version_id: String,
    pub version: String,
    pub skill_name: String,
    pub display_name: String,
    pub content_hash: String,
    pub installed_at: String,
    pub download_url: String,
    pub package_sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledSkillMetadata {
    schema_version: u8,
    skill_id: String,
    version_id: String,
    version: String,
    skill_name: String,
    display_name: String,
    content_hash: String,
    installed_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSkillResult {
    pub installed_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkillRecord {
    pub id: String,
    pub skill_id: Option<String>,
    pub version_id: Option<String>,
    pub version: Option<String>,
    pub skill_name: String,
    pub display_name: String,
    pub install_path: String,
    pub content_hash: String,
    pub installed_at: Option<String>,
    pub status: String,
    pub location: String,
    pub entry_kind: String,
    pub resolved_path: String,
    pub assigned_agents: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLocalSkillEnabledInput {
    pub skill_name: String,
    pub source_path: String,
    pub agent: String,
    pub enabled: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalSkillManagerState {
    schema_version: u32,
    assignments: HashMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    connections: HashMap<String, ManagedConnectionState>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ManagedConnectionState {
    source_path: String,
    #[serde(default)]
    target_path: String,
    mode: ManagedConnectionMode,
    source_hash: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedCopyMetadata {
    schema_version: u8,
    source_path: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ManagedConnectionMode {
    SymbolicLink,
    #[cfg(windows)]
    Junction,
    Copy,
}

impl ManagedConnectionMode {
    #[cfg(any(windows, test))]
    fn record_value(self) -> &'static str {
        match self {
            Self::SymbolicLink => "SYMLINK",
            #[cfg(windows)]
            Self::Junction => "JUNCTION",
            Self::Copy => "COPY",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ManagedDirectoryLinkKind {
    SymbolicLink,
    #[cfg(windows)]
    Junction,
}

impl ManagedDirectoryLinkKind {
    fn record_value(self) -> &'static str {
        match self {
            Self::SymbolicLink => "SYMLINK",
            #[cfg(windows)]
            Self::Junction => "JUNCTION",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl InstallError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            details: None,
        }
    }

    fn with_details(code: &str, message: impl Into<String>, details: serde_json::Value) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            details: Some(details),
        }
    }
}

fn io_error(action: &str, error: std::io::Error) -> InstallError {
    InstallError::new("LOCAL_INSTALL_IO_ERROR", format!("{action}失败：{error}"))
}

fn normalize_sha256(value: &str) -> &str {
    value
        .strip_prefix("sha256:")
        .or_else(|| value.strip_prefix("SHA256:"))
        .unwrap_or(value)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn managed_connection_key(agent: &str, skill_name: &str) -> String {
    format!("{agent}:{skill_name}")
}

fn hash_skill_directory(root: &Path) -> std::io::Result<String> {
    fn visit(root: &Path, directory: &Path, digest: &mut Sha256) -> std::io::Result<()> {
        let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if entry.file_name() == ".git"
                || (directory == root && entry.file_name() == MANAGED_COPY_METADATA_FILE)
            {
                continue;
            }
            let path = entry.path();
            let relative_path = path.strip_prefix(root).unwrap_or(&path);
            digest.update(relative_path.to_string_lossy().as_bytes());
            let file_type = entry.file_type()?;
            if file_type.is_dir() {
                digest.update(b"D");
                visit(root, &path, digest)?;
            } else if file_type.is_file() {
                digest.update(b"F");
                let mut file = File::open(&path)?;
                let mut buffer = [0_u8; 16 * 1024];
                loop {
                    let bytes_read = file.read(&mut buffer)?;
                    if bytes_read == 0 {
                        break;
                    }
                    digest.update(&buffer[..bytes_read]);
                }
            } else if file_type.is_symlink() {
                digest.update(b"L");
                digest.update(fs::read_link(&path)?.to_string_lossy().as_bytes());
            }
        }
        Ok(())
    }

    let mut digest = Sha256::new();
    visit(root, root, &mut digest)?;
    Ok(format!(
        "sha256:{}",
        digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn copy_skill_directory(source: &Path, target: &Path) -> std::io::Result<()> {
    fn copy_directory(source: &Path, target: &Path, source_root: &Path) -> std::io::Result<()> {
        fs::create_dir_all(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let target_entry = target.join(entry.file_name());
            if file_type.is_dir() {
                if entry.file_name() == ".git" {
                    continue;
                }
                copy_directory(&entry.path(), &target_entry, source_root)?;
            } else if source == source_root && entry.file_name() == MANAGED_COPY_METADATA_FILE {
                continue;
            } else {
                fs::copy(entry.path(), target_entry)?;
            }
        }
        Ok(())
    }

    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "目标目录缺少父目录")
    })?;
    fs::create_dir_all(parent)?;
    let temp_dir = TempDirBuilder::new()
        .prefix(".kocotree-agent-copy-")
        .tempdir_in(parent)?;
    let payload = temp_dir.path().join("payload");
    copy_directory(source, &payload, source)?;
    let metadata = serde_json::to_vec_pretty(&ManagedCopyMetadata {
        schema_version: 1,
        source_path: source.to_string_lossy().into_owned(),
    })
    .map_err(std::io::Error::other)?;
    fs::write(payload.join(MANAGED_COPY_METADATA_FILE), metadata)?;
    if fs::symlink_metadata(target).is_ok() {
        fs::remove_dir_all(target)?;
    }
    fs::rename(payload, target)
}

fn managed_copy_points_to(target: &Path, source: &Path) -> bool {
    let metadata = fs::read_to_string(target.join(MANAGED_COPY_METADATA_FILE))
        .ok()
        .and_then(|content| serde_json::from_str::<ManagedCopyMetadata>(&content).ok());
    metadata.is_some_and(|metadata| {
        metadata.schema_version == 1
            && PathBuf::from(metadata.source_path)
                .canonicalize()
                .is_ok_and(|path| path == source)
    })
}

fn is_valid_skill_name(skill_name: &str) -> bool {
    !skill_name.is_empty()
        && skill_name.len() <= 64
        && skill_name.split('-').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn decode_data_url(download_url: &str) -> Result<Option<Vec<u8>>, InstallError> {
    let Some((metadata, payload)) = download_url.split_once(',') else {
        return Ok(None);
    };
    if !metadata.starts_with("data:") {
        return Ok(None);
    }
    if metadata != "data:application/zip;base64"
        && metadata != "data:application/octet-stream;base64"
    {
        return Err(InstallError::new(
            "DOWNLOAD_URL_UNSUPPORTED",
            "模拟下载地址必须是 Base64 编码的 ZIP data URL",
        ));
    }
    let bytes = BASE64_STANDARD
        .decode(payload)
        .map_err(|_| InstallError::new("DOWNLOAD_FAILED", "模拟安装包的 Base64 内容无效"))?;
    Ok(Some(bytes))
}

/**
 * 功能说明：从短期下载地址获取 ZIP 字节，并限制协议、超时和文件大小。
 * 参数：
 * - `download_url`：在线接口签发的 HTTP(S) 地址，或 Mock 使用的 ZIP data URL。
 *
 * 返回值：完整 ZIP 字节；下载失败时返回结构化安装错误。
 */
async fn download_package(download_url: &str) -> Result<Vec<u8>, InstallError> {
    if let Some(bytes) = decode_data_url(download_url)? {
        if bytes.len() > MAX_PACKAGE_SIZE {
            return Err(InstallError::new(
                "PACKAGE_TOO_LARGE",
                "安装包不能超过 50 MB",
            ));
        }
        return Ok(bytes);
    }

    let parsed_url = reqwest::Url::parse(download_url)
        .map_err(|_| InstallError::new("DOWNLOAD_URL_INVALID", "下载地址格式无效"))?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err(InstallError::new(
            "DOWNLOAD_URL_UNSUPPORTED",
            "下载地址只支持 HTTP 或 HTTPS",
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| {
            InstallError::new("DOWNLOAD_FAILED", format!("创建下载客户端失败：{error}"))
        })?;
    let response = client.get(parsed_url).send().await.map_err(|error| {
        InstallError::new("DOWNLOAD_FAILED", format!("下载安装包失败：{error}"))
    })?;
    if !response.status().is_success() {
        return Err(InstallError::new(
            "DOWNLOAD_FAILED",
            format!("下载安装包失败，服务端返回 {}", response.status()),
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_PACKAGE_SIZE as u64)
    {
        return Err(InstallError::new(
            "PACKAGE_TOO_LARGE",
            "安装包不能超过 50 MB",
        ));
    }
    let bytes = response.bytes().await.map_err(|error| {
        InstallError::new("DOWNLOAD_FAILED", format!("读取安装包失败：{error}"))
    })?;
    if bytes.len() > MAX_PACKAGE_SIZE {
        return Err(InstallError::new(
            "PACKAGE_TOO_LARGE",
            "安装包不能超过 50 MB",
        ));
    }
    Ok(bytes.to_vec())
}

fn validate_package_hash(bytes: &[u8], expected: &str) -> Result<(), InstallError> {
    let actual = sha256_hex(bytes);
    if !actual.eq_ignore_ascii_case(normalize_sha256(expected)) {
        return Err(InstallError::with_details(
            "PACKAGE_HASH_MISMATCH",
            "安装包 SHA-256 校验失败",
            serde_json::json!({
                "expected": expected,
                "actual": format!("sha256:{actual}"),
            }),
        ));
    }
    Ok(())
}

fn sanitized_segments(raw_name: &str) -> Result<Vec<String>, InstallError> {
    if raw_name.is_empty()
        || raw_name.len() > 1_024
        || raw_name.contains('\0')
        || raw_name.contains('\\')
        || raw_name.starts_with('/')
        || raw_name.as_bytes().get(1) == Some(&b':')
    {
        return Err(InstallError::with_details(
            "INVALID_SKILL_PACKAGE",
            "ZIP 中包含不安全的文件路径",
            serde_json::json!({ "path": raw_name }),
        ));
    }
    let trimmed = raw_name.trim_end_matches('/');
    let segments: Vec<String> = trimmed.split('/').map(str::to_string).collect();
    if segments.is_empty()
        || segments
            .iter()
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(InstallError::with_details(
            "INVALID_SKILL_PACKAGE",
            "ZIP 中包含路径穿越或无效路径",
            serde_json::json!({ "path": raw_name }),
        ));
    }
    Ok(segments)
}

fn is_symbolic_link(unix_mode: Option<u32>) -> bool {
    unix_mode.is_some_and(|mode| mode & 0o170000 == 0o120000)
}

fn parse_skill_name(skill_md: &str) -> Result<String, InstallError> {
    let normalized = skill_md.replace("\r\n", "\n");
    let Some(frontmatter) = normalized.strip_prefix("---\n") else {
        return Err(InstallError::new(
            "INVALID_SKILL_PACKAGE",
            "SKILL.md 缺少合法的 YAML frontmatter",
        ));
    };
    let Some(end_index) = frontmatter.find("\n---") else {
        return Err(InstallError::new(
            "INVALID_SKILL_PACKAGE",
            "SKILL.md 缺少合法的 YAML frontmatter",
        ));
    };
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(&frontmatter[..end_index]).map_err(|_| {
            InstallError::new(
                "INVALID_SKILL_PACKAGE",
                "SKILL.md 的 YAML frontmatter 无法解析",
            )
        })?;
    yaml.get("name")
        .and_then(serde_yaml::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            InstallError::new(
                "INVALID_SKILL_PACKAGE",
                "SKILL.md 的 frontmatter 必须包含非空 name",
            )
        })
}

/**
 * 功能说明：校验 ZIP 结构并将内容安全解压到临时目录。
 * 参数：
 * - `package_bytes`：已经完成包哈希校验的 ZIP 字节。
 * - `destination`：只用于本次安装的空临时目录。
 * - `expected_skill_name`：平台版本声明的 Skill 名称。
 *
 * 返回值：成功时返回空值；结构、大小或名称不合法时返回结构化错误。
 */
fn extract_package(
    package_bytes: &[u8],
    destination: &Path,
    expected_skill_name: &str,
) -> Result<(), InstallError> {
    let mut archive = ZipArchive::new(Cursor::new(package_bytes))
        .map_err(|_| InstallError::new("INVALID_SKILL_PACKAGE", "ZIP 已损坏或无法读取"))?;

    let mut skill_md_candidates = Vec::new();
    let mut total_declared_size = 0_u64;
    let mut regular_file_count = 0_usize;

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|_| InstallError::new("INVALID_SKILL_PACKAGE", "ZIP 文件条目无法读取"))?;
        let segments = sanitized_segments(entry.name())?;
        if is_symbolic_link(entry.unix_mode()) {
            return Err(InstallError::with_details(
                "INVALID_SKILL_PACKAGE",
                "ZIP 不能包含符号链接",
                serde_json::json!({ "path": entry.name() }),
            ));
        }
        if !entry.is_dir() {
            regular_file_count += 1;
            total_declared_size = total_declared_size.saturating_add(entry.size());
            if segments.last().is_some_and(|name| name == "SKILL.md") && segments.len() <= 2 {
                skill_md_candidates.push(segments);
            }
        }
    }

    if regular_file_count > MAX_FILE_COUNT {
        return Err(InstallError::new(
            "PACKAGE_TOO_LARGE",
            "ZIP 中的普通文件不能超过 2000 个",
        ));
    }
    if total_declared_size > MAX_UNCOMPRESSED_SIZE {
        return Err(InstallError::new(
            "PACKAGE_TOO_LARGE",
            "ZIP 解压后的总大小不能超过 200 MB",
        ));
    }
    if skill_md_candidates.len() != 1 {
        return Err(InstallError::new(
            "INVALID_SKILL_PACKAGE",
            "ZIP 根目录或单层外包装目录中必须且只能包含一个 SKILL.md",
        ));
    }

    let wrapper = if skill_md_candidates[0].len() == 2 {
        Some(skill_md_candidates[0][0].clone())
    } else {
        None
    };
    let mut normalized_paths: HashMap<String, String> = HashMap::new();
    let mut total_written_size = 0_u64;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| InstallError::new("INVALID_SKILL_PACKAGE", "ZIP 文件条目无法读取"))?;
        let segments = sanitized_segments(entry.name())?;
        let normalized_segments = match &wrapper {
            Some(root) if segments.first() == Some(root) => &segments[1..],
            Some(_) => {
                return Err(InstallError::with_details(
                    "INVALID_SKILL_PACKAGE",
                    "ZIP 的单层外包装目录之外不能包含其他文件",
                    serde_json::json!({ "path": entry.name() }),
                ));
            }
            None => &segments[..],
        };
        if normalized_segments.is_empty() {
            continue;
        }
        let normalized_path = normalized_segments.join("/");
        let collision_key = normalized_path.to_lowercase();
        if let Some(existing) = normalized_paths.get(&collision_key) {
            return Err(InstallError::with_details(
                "INVALID_SKILL_PACKAGE",
                "ZIP 中包含重复或大小写冲突的路径",
                serde_json::json!({ "paths": [existing, &normalized_path] }),
            ));
        }
        normalized_paths.insert(collision_key, normalized_path.clone());

        let output_path = normalized_segments
            .iter()
            .fold(PathBuf::from(destination), |path, segment| {
                path.join(segment)
            });
        if entry.is_dir() {
            fs::create_dir_all(&output_path).map_err(|error| io_error("创建安装目录", error))?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| io_error("创建安装目录", error))?;
        }
        let mut output =
            File::create(&output_path).map_err(|error| io_error("创建 Skill 文件", error))?;
        let remaining = MAX_UNCOMPRESSED_SIZE.saturating_sub(total_written_size);
        let written = std::io::copy(&mut entry.by_ref().take(remaining + 1), &mut output)
            .map_err(|error| io_error("解压 Skill 文件", error))?;
        total_written_size = total_written_size.saturating_add(written);
        if total_written_size > MAX_UNCOMPRESSED_SIZE {
            return Err(InstallError::new(
                "PACKAGE_TOO_LARGE",
                "ZIP 解压后的总大小不能超过 200 MB",
            ));
        }
    }

    let skill_md_path = destination.join("SKILL.md");
    let metadata = fs::metadata(&skill_md_path)
        .map_err(|_| InstallError::new("INVALID_SKILL_PACKAGE", "ZIP 中没有找到 SKILL.md"))?;
    if metadata.len() > MAX_SKILL_MD_SIZE {
        return Err(InstallError::new(
            "INVALID_SKILL_PACKAGE",
            "SKILL.md 不能超过 1 MB",
        ));
    }
    let mut skill_md = String::new();
    File::open(&skill_md_path)
        .and_then(|mut file| file.read_to_string(&mut skill_md))
        .map_err(|_| {
            InstallError::new("INVALID_SKILL_PACKAGE", "SKILL.md 必须是有效的 UTF-8 文本")
        })?;
    let actual_skill_name = parse_skill_name(&skill_md)?;
    if actual_skill_name != expected_skill_name {
        return Err(InstallError::with_details(
            "SKILL_NAME_MISMATCH",
            "SKILL.md 中的名称与目标 Skill 不一致",
            serde_json::json!({
                "expectedSkillName": expected_skill_name,
                "actualSkillName": actual_skill_name,
            }),
        ));
    }
    Ok(())
}

/**
 * 功能说明：把已下载并校验的 ZIP 安装到指定 Skill 根目录。
 * 参数：
 * - `input`：目标 Skill、版本、下载地址和包哈希。
 * - `package_bytes`：完整 ZIP 字节。
 * - `skills_root`：平台解析后的 Skill 安装根目录。
 *
 * 返回值：最终安装路径；目标冲突或文件系统失败时不修改已有目录。
 */
fn install_package_bytes(
    input: &InstallSkillInput,
    package_bytes: &[u8],
    skills_root: &Path,
) -> Result<InstallSkillResult, InstallError> {
    if !is_valid_skill_name(&input.skill_name) {
        return Err(InstallError::new(
            "INVALID_SKILL_NAME",
            "Skill 名称只能包含小写字母、数字和单个连字符",
        ));
    }
    validate_package_hash(package_bytes, &input.package_sha256)?;
    fs::create_dir_all(skills_root).map_err(|error| io_error("创建 Skill 根目录", error))?;

    let target = skills_root.join(&input.skill_name);
    match fs::symlink_metadata(&target) {
        Ok(_) => {
            warn!(
                "Skill 安装因目标目录冲突而停止：skill_name={}",
                input.skill_name
            );
            return Err(InstallError::with_details(
                "LOCAL_SKILL_CONFLICT",
                "本地已存在同名 Skill，当前版本暂不支持覆盖",
                serde_json::json!({
                    "targetPath": target,
                    "forceSupported": false,
                }),
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error("检查目标 Skill 目录", error)),
    }

    let temp_dir = TempDirBuilder::new()
        .prefix(".kocotree-install-")
        .tempdir_in(skills_root)
        .map_err(|error| io_error("创建安装临时目录", error))?;
    let payload = temp_dir.path().join("payload");
    fs::create_dir(&payload).map_err(|error| io_error("创建解压临时目录", error))?;
    extract_package(package_bytes, &payload, &input.skill_name)?;
    let install_metadata = InstalledSkillMetadata {
        schema_version: 1,
        skill_id: input.skill_id.clone(),
        version_id: input.version_id.clone(),
        version: input.version.clone(),
        skill_name: input.skill_name.clone(),
        display_name: input.display_name.clone(),
        content_hash: input.content_hash.clone(),
        installed_at: input.installed_at.clone(),
    };
    let metadata_bytes = serde_json::to_vec_pretty(&install_metadata).map_err(|error| {
        InstallError::new(
            "LOCAL_INSTALL_METADATA_ERROR",
            format!("生成安装元数据失败：{error}"),
        )
    })?;
    fs::write(payload.join(INSTALL_METADATA_FILE), metadata_bytes)
        .map_err(|error| io_error("写入安装元数据", error))?;
    fs::rename(&payload, &target).map_err(|error| io_error("写入 Skill 目录", error))?;

    Ok(InstallSkillResult {
        installed_path: target.to_string_lossy().into_owned(),
    })
}

/**
 * 功能说明：执行平台版本的第一版真实安装流程。
 * 参数：
 * - `input`：目标 Skill、版本、下载地址和包哈希。
 *
 * 返回值：安装成功路径，或可供前端处理的结构化错误。
 */
#[tauri::command]
pub async fn install_skill(input: InstallSkillInput) -> Result<InstallSkillResult, InstallError> {
    info!(
        "开始安装 Skill：skill_id={}, version_id={}, version={}, skill_name={}",
        input.skill_id, input.version_id, input.version, input.skill_name
    );
    let result = async {
        let package_bytes = download_package(&input.download_url).await?;
        info!(
            "Skill 安装包下载完成：skill_name={}, bytes={}",
            input.skill_name,
            package_bytes.len()
        );
        let home = dirs::home_dir().ok_or_else(|| {
            InstallError::new("HOME_DIRECTORY_UNAVAILABLE", "无法获取当前用户主目录")
        })?;
        let skills_root = home.join(".agents").join("skills");
        install_package_bytes(&input, &package_bytes, &skills_root)
    }
    .await;

    match &result {
        Ok(installed) => info!(
            "Skill 安装完成：skill_name={}, installed_path={}",
            input.skill_name, installed.installed_path
        ),
        Err(install_error) => error!(
            "Skill 安装失败：skill_name={}, code={}, message={}",
            input.skill_name, install_error.code, install_error.message
        ),
    }
    result
}

fn scan_skills_root(root: &Path, location: &str, records: &mut Vec<LocalSkillRecord>) {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            warn!(
                "读取本地 Skill 根目录失败：root={}, error={error}",
                root.display()
            );
            return;
        }
    };

    for entry in entries.flatten() {
        let directory_name = entry.file_name().to_string_lossy().into_owned();
        if directory_name.starts_with('.') {
            continue;
        }
        let skill_path = entry.path();
        let metadata = match fs::symlink_metadata(&skill_path) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let managed_link_kind = match managed_directory_link_kind(&skill_path, &metadata) {
            Ok(kind) => kind,
            Err(error) => {
                warn!(
                    "检查本地 Skill 连接类型失败：path={}, error={error}",
                    skill_path.display()
                );
                continue;
            }
        };
        let file_type = metadata.file_type();
        let is_directory = file_type.is_dir() || managed_link_kind.is_some();
        if !is_directory || !skill_path.join("SKILL.md").is_file() {
            continue;
        }
        let entry_kind = managed_link_kind
            .map(ManagedDirectoryLinkKind::record_value)
            .unwrap_or("DIRECTORY");
        let resolved_path = skill_path
            .canonicalize()
            .unwrap_or_else(|_| skill_path.clone())
            .to_string_lossy()
            .into_owned();
        let skill_md_path = skill_path.join("SKILL.md");
        let skill_md_size = match fs::metadata(&skill_md_path) {
            Ok(metadata) => metadata.len(),
            Err(_) => continue,
        };
        if skill_md_size > MAX_SKILL_MD_SIZE {
            warn!(
                "跳过过大的本地 SKILL.md：path={}, bytes={skill_md_size}",
                skill_md_path.display()
            );
            continue;
        }
        let skill_md = match fs::read_to_string(&skill_md_path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let skill_name = parse_skill_name(&skill_md).unwrap_or_else(|_| directory_name.clone());
        let metadata = fs::read_to_string(skill_path.join(INSTALL_METADATA_FILE))
            .ok()
            .and_then(|content| serde_json::from_str::<InstalledSkillMetadata>(&content).ok())
            .filter(|metadata| metadata.schema_version == 1 && metadata.skill_name == skill_name);
        let path_text = skill_path.to_string_lossy().into_owned();
        let local_id_hash = sha256_hex(path_text.as_bytes());
        let skill_md_hash = sha256_hex(skill_md.as_bytes());
        let (skill_id, version_id, version, display_name, content_hash, installed_at, status) =
            match metadata {
                Some(metadata) => (
                    Some(metadata.skill_id),
                    Some(metadata.version_id),
                    Some(metadata.version),
                    metadata.display_name,
                    metadata.content_hash,
                    Some(metadata.installed_at),
                    "PLATFORM_INSTALLED".to_string(),
                ),
                None => (
                    None,
                    None,
                    None,
                    skill_name.clone(),
                    format!("sha256:{skill_md_hash}"),
                    None,
                    "LOCAL_UNKNOWN".to_string(),
                ),
            };
        records.push(LocalSkillRecord {
            id: format!("local-{}", &local_id_hash[..16]),
            skill_id,
            version_id,
            version,
            skill_name,
            display_name,
            install_path: path_text,
            content_hash,
            installed_at,
            status,
            location: location.to_string(),
            entry_kind: entry_kind.to_string(),
            resolved_path,
            assigned_agents: Vec::new(),
        });
    }
}

fn empty_local_skill_manager_state() -> LocalSkillManagerState {
    LocalSkillManagerState {
        schema_version: 1,
        assignments: HashMap::new(),
        connections: HashMap::new(),
    }
}

fn local_skill_manager_state_path(home: &Path) -> PathBuf {
    home.join(".skills-manager").join(MANAGER_STATE_FILE)
}

fn load_local_skill_manager_state(home: &Path) -> Result<LocalSkillManagerState, InstallError> {
    let state_path = local_skill_manager_state_path(home);
    let content = match fs::read_to_string(&state_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(empty_local_skill_manager_state());
        }
        Err(error) => return Err(io_error("读取 Skill 管理状态", error)),
    };
    let state = serde_json::from_str::<LocalSkillManagerState>(&content).map_err(|_| {
        InstallError::new("LOCAL_SKILL_STATE_INVALID", "Skill 管理状态文件格式无效")
    })?;
    if state.schema_version != 1 {
        return Err(InstallError::new(
            "LOCAL_SKILL_STATE_UNSUPPORTED",
            "Skill 管理状态文件版本不受支持",
        ));
    }
    Ok(state)
}

fn save_local_skill_manager_state(
    home: &Path,
    state: &LocalSkillManagerState,
) -> Result<(), InstallError> {
    let state_path = local_skill_manager_state_path(home);
    let manager_directory = state_path.parent().ok_or_else(|| {
        InstallError::new(
            "LOCAL_SKILL_STATE_PATH_INVALID",
            "Skill 管理状态文件路径无效",
        )
    })?;
    fs::create_dir_all(manager_directory)
        .map_err(|error| io_error("创建 Skill 管理目录", error))?;
    let content = serde_json::to_vec_pretty(state).map_err(|_| {
        InstallError::new(
            "LOCAL_SKILL_STATE_SERIALIZE_FAILED",
            "无法生成 Skill 管理状态",
        )
    })?;
    fs::write(state_path, content).map_err(|error| io_error("保存 Skill 管理状态", error))
}

#[cfg(any(windows, test))]
fn refresh_managed_copies(home: &Path) -> Result<(), InstallError> {
    let mut state = load_local_skill_manager_state(home)?;
    let allowed_source_roots = [
        home.join(".agents").join("skills"),
        home.join(".skills-manager").join("skills"),
    ]
    .into_iter()
    .filter_map(|root| root.canonicalize().ok())
    .collect::<Vec<_>>();
    let mut state_changed = false;

    for (key, connection) in &mut state.connections {
        if connection.mode != ManagedConnectionMode::Copy {
            continue;
        }
        let Some((agent, _skill_name)) = key.split_once(':') else {
            continue;
        };
        let Ok(source) = PathBuf::from(&connection.source_path).canonicalize() else {
            continue;
        };
        if !allowed_source_roots
            .iter()
            .any(|root| source.parent() == Some(root.as_path()))
            || !source.join("SKILL.md").is_file()
        {
            continue;
        }
        let expected_root = preferred_agent_skills_root(home, agent)?;
        let target = if connection.target_path.is_empty() {
            let Some(directory_name) = source.file_name() else {
                continue;
            };
            expected_root.join(directory_name)
        } else {
            PathBuf::from(&connection.target_path)
        };
        if target.parent() != Some(expected_root.as_path()) {
            continue;
        }
        match fs::symlink_metadata(&target) {
            Ok(metadata) => {
                let link_kind = managed_directory_link_kind(&target, &metadata)
                    .map_err(|error| io_error("检查 Agent Skill 副本", error))?;
                if link_kind.is_some()
                    || !metadata.is_dir()
                    || !managed_copy_points_to(&target, &source)
                {
                    continue;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error("检查 Agent Skill 副本", error)),
        }

        let source_hash =
            hash_skill_directory(&source).map_err(|error| io_error("计算 Skill 摘要", error))?;
        let target_is_current =
            hash_skill_directory(&target).is_ok_and(|target_hash| target_hash == source_hash);
        if !target_is_current {
            copy_skill_directory(&source, &target)
                .map_err(|error| io_error("同步 Agent Skill 副本", error))?;
        }
        let canonical_source = source.to_string_lossy().into_owned();
        let target_text = target.to_string_lossy().into_owned();
        if connection.source_path != canonical_source
            || connection.target_path != target_text
            || connection.source_hash != source_hash
        {
            connection.source_path = canonical_source;
            connection.target_path = target_text;
            connection.source_hash = source_hash;
            state_changed = true;
        }
    }

    if state_changed {
        save_local_skill_manager_state(home, &state)?;
    }
    Ok(())
}

fn scan_local_skills_from_home(home: &Path) -> Result<Vec<LocalSkillRecord>, InstallError> {
    #[cfg(any(windows, test))]
    if let Err(error) = refresh_managed_copies(home) {
        warn!(
            "刷新 Windows Skill 副本失败，继续扫描：code={}, message={}",
            error.code, error.message
        );
    }
    let roots = [
        ("MANAGER", home.join(".skills-manager").join("skills")),
        ("AGENTS", home.join(".agents").join("skills")),
        ("CLAUDE", home.join(".claude").join("skills")),
        ("CODEX", home.join(".codex").join("skills")),
    ];
    let mut records = Vec::new();
    for (location, root) in roots {
        scan_skills_root(&root, location, &mut records);
    }
    let manager_state = load_local_skill_manager_state(home).unwrap_or_else(|error| {
        warn!(
            "读取 Skill 管理状态失败，按空状态继续：code={}, message={}",
            error.code, error.message
        );
        empty_local_skill_manager_state()
    });
    #[cfg(any(windows, test))]
    {
        for record in records
            .iter_mut()
            .filter(|record| record.location == "CLAUDE" || record.location == "CODEX")
        {
            let agent = if record.location == "CLAUDE" {
                "claude"
            } else {
                "codex"
            };
            let key = managed_connection_key(agent, &record.skill_name);
            let Some(connection) = manager_state.connections.get(&key) else {
                continue;
            };
            if connection.mode != ManagedConnectionMode::Copy {
                continue;
            }
            let Ok(expected_root) = preferred_agent_skills_root(home, agent) else {
                continue;
            };
            if Path::new(&record.install_path).parent() != Some(expected_root.as_path()) {
                continue;
            }
            let Ok(source_path) = PathBuf::from(&connection.source_path).canonicalize() else {
                continue;
            };
            if !source_path.join("SKILL.md").is_file() {
                continue;
            }
            if !managed_copy_points_to(Path::new(&record.install_path), &source_path) {
                continue;
            }
            record.entry_kind = connection.mode.record_value().to_string();
            record.resolved_path = source_path.to_string_lossy().into_owned();
        }
    }
    for record in records
        .iter_mut()
        .filter(|record| record.location == "MANAGER" || record.location == "AGENTS")
    {
        record.assigned_agents = ["claude", "codex"]
            .iter()
            .filter(|agent| {
                manager_state
                    .assignments
                    .get(**agent)
                    .is_some_and(|skills| skills.iter().any(|name| name == &record.skill_name))
            })
            .map(|agent| (*agent).to_string())
            .collect();
    }
    records.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
            .then_with(|| left.install_path.cmp(&right.install_path))
    });
    Ok(records)
}

fn scan_local_skills_from_disk() -> Result<Vec<LocalSkillRecord>, InstallError> {
    let home = dirs::home_dir()
        .ok_or_else(|| InstallError::new("HOME_DIRECTORY_UNAVAILABLE", "无法获取当前用户主目录"))?;
    scan_local_skills_from_home(&home)
}

fn agent_skills_roots(home: &Path, agent: &str) -> Result<Vec<PathBuf>, InstallError> {
    match agent {
        "claude" => Ok(vec![home.join(".claude").join("skills")]),
        "codex" => Ok(vec![home.join(".codex").join("skills")]),
        _ => Err(InstallError::new(
            "LOCAL_SKILL_AGENT_UNSUPPORTED",
            "不支持的 Agent 类型",
        )),
    }
}

fn preferred_agent_skills_root(home: &Path, agent: &str) -> Result<PathBuf, InstallError> {
    match agent {
        "claude" => Ok(home.join(".claude").join("skills")),
        "codex" => Ok(home.join(".codex").join("skills")),
        _ => Err(InstallError::new(
            "LOCAL_SKILL_AGENT_UNSUPPORTED",
            "不支持的 Agent 类型",
        )),
    }
}

#[cfg(unix)]
fn managed_directory_link_kind(
    _path: &Path,
    metadata: &fs::Metadata,
) -> std::io::Result<Option<ManagedDirectoryLinkKind>> {
    Ok(metadata
        .file_type()
        .is_symlink()
        .then_some(ManagedDirectoryLinkKind::SymbolicLink))
}

#[cfg(windows)]
fn managed_directory_link_kind(
    path: &Path,
    metadata: &fs::Metadata,
) -> std::io::Result<Option<ManagedDirectoryLinkKind>> {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

    if metadata.file_type().is_symlink() {
        return Ok(Some(ManagedDirectoryLinkKind::SymbolicLink));
    }
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        return Ok(None);
    }
    if junction::exists(path)? {
        return Ok(Some(ManagedDirectoryLinkKind::Junction));
    }
    Ok(None)
}

#[cfg(unix)]
fn create_managed_directory_link(
    source: &Path,
    target: &Path,
) -> std::io::Result<ManagedConnectionMode> {
    std::os::unix::fs::symlink(source, target)?;
    Ok(ManagedConnectionMode::SymbolicLink)
}

#[cfg(windows)]
fn create_windows_managed_connection_with<S, J, C>(
    mut create_symlink: S,
    mut create_junction: J,
    mut copy_directory: C,
) -> std::io::Result<ManagedConnectionMode>
where
    S: FnMut() -> std::io::Result<()>,
    J: FnMut() -> std::io::Result<()>,
    C: FnMut() -> std::io::Result<()>,
{
    match create_symlink() {
        Ok(()) => Ok(ManagedConnectionMode::SymbolicLink),
        Err(symlink_error) => match create_junction() {
            Ok(()) => Ok(ManagedConnectionMode::Junction),
            Err(junction_error) => {
                copy_directory().map_err(|copy_error| {
                    std::io::Error::new(
                        copy_error.kind(),
                        format!(
                            "无法创建 Windows 目录软链接（{symlink_error}）或 Junction（{junction_error}），复制目录也失败（{copy_error}）"
                        ),
                    )
                })?;
                Ok(ManagedConnectionMode::Copy)
            }
        },
    }
}

#[cfg(windows)]
fn create_managed_directory_link(
    source: &Path,
    target: &Path,
) -> std::io::Result<ManagedConnectionMode> {
    create_windows_managed_connection_with(
        || std::os::windows::fs::symlink_dir(source, target),
        || junction::create(source, target),
        || {
            // Junction 创建失败时可能留下空目录；只删除空目录，不覆盖用户数据。
            let _ = fs::remove_dir(target);
            copy_skill_directory(source, target)
        },
    )
}

#[cfg(unix)]
fn remove_managed_directory_link(
    target: &Path,
    _kind: ManagedDirectoryLinkKind,
) -> std::io::Result<()> {
    fs::remove_file(target)
}

#[cfg(windows)]
fn remove_managed_directory_link(
    target: &Path,
    kind: ManagedDirectoryLinkKind,
) -> std::io::Result<()> {
    match kind {
        ManagedDirectoryLinkKind::SymbolicLink => fs::remove_dir(target),
        ManagedDirectoryLinkKind::Junction => {
            junction::delete(target)?;
            fs::remove_dir(target)
        }
    }
}

fn connection_mode_from_link_kind(kind: ManagedDirectoryLinkKind) -> ManagedConnectionMode {
    match kind {
        ManagedDirectoryLinkKind::SymbolicLink => ManagedConnectionMode::SymbolicLink,
        #[cfg(windows)]
        ManagedDirectoryLinkKind::Junction => ManagedConnectionMode::Junction,
    }
}

fn remove_managed_connection_target(
    target: &Path,
    mode: ManagedConnectionMode,
) -> std::io::Result<()> {
    match mode {
        ManagedConnectionMode::SymbolicLink => {
            remove_managed_directory_link(target, ManagedDirectoryLinkKind::SymbolicLink)
        }
        #[cfg(windows)]
        ManagedConnectionMode::Junction => {
            remove_managed_directory_link(target, ManagedDirectoryLinkKind::Junction)
        }
        ManagedConnectionMode::Copy => fs::remove_dir_all(target),
    }
}

fn set_local_skill_enabled_at_home(
    home: &Path,
    input: SetLocalSkillEnabledInput,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    let source_path = PathBuf::from(&input.source_path);
    let canonical_source = source_path.canonicalize().map_err(|error| {
        InstallError::new(
            "LOCAL_SKILL_SOURCE_MISSING",
            format!("Skill 本体不存在：{error}"),
        )
    })?;
    let allowed_source_roots = [
        home.join(".agents").join("skills"),
        home.join(".skills-manager").join("skills"),
    ]
    .into_iter()
    .filter_map(|root| root.canonicalize().ok())
    .collect::<Vec<_>>();
    let source_is_direct_child = allowed_source_roots
        .iter()
        .any(|root| canonical_source.parent() == Some(root.as_path()));
    if !source_is_direct_child || !canonical_source.join("SKILL.md").is_file() {
        return Err(InstallError::new(
            "LOCAL_SKILL_SOURCE_UNMANAGED",
            "只能控制用户目录下 .agents/skills 或兼容仓库中的实体 Skill",
        ));
    }
    let skill_md = fs::read_to_string(canonical_source.join("SKILL.md"))
        .map_err(|error| io_error("读取 Skill 定义", error))?;
    let parsed_skill_name = parse_skill_name(&skill_md)?;
    if parsed_skill_name != input.skill_name {
        return Err(InstallError::new(
            "LOCAL_SKILL_NAME_MISMATCH",
            "Skill 名称与本体中的定义不一致",
        ));
    }
    let directory_name = source_path
        .file_name()
        .ok_or_else(|| InstallError::new("LOCAL_SKILL_PATH_INVALID", "Skill 本体路径无效"))?;
    let agent_roots = agent_skills_roots(home, &input.agent)?;
    let target_paths = agent_roots
        .iter()
        .map(|root| root.join(directory_name))
        .collect::<Vec<_>>();
    let connection_key = managed_connection_key(&input.agent, &input.skill_name);
    let mut manager_state = load_local_skill_manager_state(home)?;
    let mut manager_state_changed = false;
    #[cfg(any(windows, test))]
    let stored_connection = manager_state.connections.get(&connection_key).cloned();
    #[cfg(any(windows, test))]
    let stored_copy_matches_source = stored_connection.as_ref().is_some_and(|connection| {
        connection.mode == ManagedConnectionMode::Copy
            && PathBuf::from(&connection.source_path)
                .canonicalize()
                .is_ok_and(|path| path == canonical_source)
    });
    #[cfg(not(any(windows, test)))]
    let stored_copy_matches_source = false;

    if input.enabled {
        let mut active_mode = None;
        for target_path in &target_paths {
            match fs::symlink_metadata(target_path) {
                Ok(metadata) => {
                    let link_kind = managed_directory_link_kind(target_path, &metadata)
                        .map_err(|error| io_error("检查 Agent Skill 连接", error))?;
                    if let Some(link_kind) = link_kind {
                        let current_target = target_path.canonicalize().map_err(|_| {
                            InstallError::new(
                                "LOCAL_SKILL_TARGET_CONFLICT",
                                "目标位置已有失效或指向其他位置的连接",
                            )
                        })?;
                        if current_target != canonical_source {
                            return Err(InstallError::new(
                                "LOCAL_SKILL_TARGET_CONFLICT",
                                "目标位置已有指向其他 Skill 的连接",
                            ));
                        }
                        active_mode = Some(connection_mode_from_link_kind(link_kind));
                    } else if metadata.is_dir()
                        && stored_copy_matches_source
                        && managed_copy_points_to(target_path, &canonical_source)
                    {
                        let source_hash = hash_skill_directory(&canonical_source)
                            .map_err(|error| io_error("计算 Skill 摘要", error))?;
                        let target_hash = hash_skill_directory(target_path)
                            .map_err(|error| io_error("计算 Agent Skill 副本摘要", error))?;
                        if target_hash != source_hash {
                            copy_skill_directory(&canonical_source, target_path)
                                .map_err(|error| io_error("更新 Agent Skill 副本", error))?;
                        }
                        active_mode = Some(ManagedConnectionMode::Copy);
                    } else {
                        return Err(InstallError::new(
                            "LOCAL_SKILL_TARGET_CONFLICT",
                            "Agent 可读取的目录中已有独立安装的同名 Skill，未进行覆盖",
                        ));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(io_error("检查 Agent Skill 入口", error));
                }
            }
        }
        if active_mode.is_none() {
            let preferred_root = preferred_agent_skills_root(home, &input.agent)?;
            let target_path = preferred_root.join(directory_name);
            fs::create_dir_all(&preferred_root)
                .map_err(|error| io_error("创建 Agent Skill 目录", error))?;
            active_mode = Some(
                create_managed_directory_link(&canonical_source, &target_path)
                    .map_err(|error| io_error("开启 Skill", error))?,
            );
        }
        let active_mode = active_mode.expect("启用成功后必须存在连接模式");
        if active_mode == ManagedConnectionMode::Copy {
            let source_hash = hash_skill_directory(&canonical_source)
                .map_err(|error| io_error("计算 Skill 摘要", error))?;
            let connection = ManagedConnectionState {
                source_path: canonical_source.to_string_lossy().into_owned(),
                target_path: preferred_agent_skills_root(home, &input.agent)?
                    .join(directory_name)
                    .to_string_lossy()
                    .into_owned(),
                mode: active_mode,
                source_hash,
            };
            manager_state_changed |=
                manager_state.connections.get(&connection_key) != Some(&connection);
            manager_state.connections.insert(connection_key, connection);
        } else {
            manager_state_changed |= manager_state.connections.remove(&connection_key).is_some();
        }
    } else {
        let mut removable_paths = Vec::new();
        for target_path in &target_paths {
            match fs::symlink_metadata(target_path) {
                Ok(metadata) => {
                    let link_kind = managed_directory_link_kind(target_path, &metadata)
                        .map_err(|error| io_error("检查 Agent Skill 连接", error))?;
                    if let Some(link_kind) = link_kind {
                        let current_target = target_path.canonicalize().map_err(|_| {
                            InstallError::new(
                                "LOCAL_SKILL_TARGET_CONFLICT",
                                "该连接已失效，未自动删除",
                            )
                        })?;
                        if current_target != canonical_source {
                            return Err(InstallError::new(
                                "LOCAL_SKILL_TARGET_CONFLICT",
                                "该连接指向其他位置，未自动删除",
                            ));
                        }
                        removable_paths.push((
                            target_path.clone(),
                            connection_mode_from_link_kind(link_kind),
                        ));
                    } else if metadata.is_dir()
                        && stored_copy_matches_source
                        && managed_copy_points_to(target_path, &canonical_source)
                    {
                        removable_paths.push((target_path.clone(), ManagedConnectionMode::Copy));
                    } else {
                        return Err(InstallError::new(
                            "LOCAL_SKILL_NOT_MANAGED_LINK",
                            "Agent 可读取的目录中存在独立安装的同名 Skill，不能通过开关关闭",
                        ));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(io_error("检查 Agent Skill 入口", error));
                }
            }
        }
        for (target_path, mode) in removable_paths {
            remove_managed_connection_target(&target_path, mode)
                .map_err(|error| io_error("关闭 Skill", error))?;
        }
        manager_state_changed |= manager_state.connections.remove(&connection_key).is_some();
    }

    let assigned_skills = manager_state
        .assignments
        .entry(input.agent.clone())
        .or_default();
    if !assigned_skills.iter().any(|name| name == &input.skill_name) {
        assigned_skills.push(input.skill_name);
        assigned_skills.sort();
        manager_state_changed = true;
    }
    if manager_state_changed {
        save_local_skill_manager_state(home, &manager_state)?;
    }

    scan_local_skills_from_home(home)
}

fn set_local_skill_enabled_on_disk(
    input: SetLocalSkillEnabledInput,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    let home = dirs::home_dir()
        .ok_or_else(|| InstallError::new("HOME_DIRECTORY_UNAVAILABLE", "无法获取当前用户主目录"))?;
    set_local_skill_enabled_at_home(&home, input)
}

/** 只读扫描全部 Agents 工作区、兼容仓库以及 Claude Code/Codex 目录。 */
#[tauri::command]
pub async fn scan_local_skills() -> Result<Vec<LocalSkillRecord>, InstallError> {
    tauri::async_runtime::spawn_blocking(scan_local_skills_from_disk)
        .await
        .map_err(|error| {
            InstallError::new(
                "LOCAL_SKILL_SCAN_FAILED",
                format!("扫描本地 Skill 失败：{error}"),
            )
        })?
}

/** 通过创建或移除受管目录连接，开启或关闭指定 Agent 的 Skill。 */
#[tauri::command]
pub async fn set_local_skill_enabled(
    input: SetLocalSkillEnabledInput,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    tauri::async_runtime::spawn_blocking(move || set_local_skill_enabled_on_disk(input))
        .await
        .map_err(|error| {
            InstallError::new(
                "LOCAL_SKILL_CONTROL_FAILED",
                format!("更新本地 Skill 状态失败：{error}"),
            )
        })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn create_package(skill_name: &str, wrapper: Option<&str>) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = ZipWriter::new(&mut cursor);
            let options = SimpleFileOptions::default();
            let prefix = wrapper.map(|value| format!("{value}/")).unwrap_or_default();
            writer
                .start_file(format!("{prefix}SKILL.md"), options)
                .unwrap();
            writer
                .write_all(
                    format!("---\nname: {skill_name}\ndescription: 测试安装流程\n---\n").as_bytes(),
                )
                .unwrap();
            writer
                .start_file(format!("{prefix}references/usage.md"), options)
                .unwrap();
            writer.write_all(b"# Usage\n").unwrap();
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    fn input_for(skill_name: &str, bytes: &[u8]) -> InstallSkillInput {
        InstallSkillInput {
            skill_id: "skill-test".to_string(),
            version_id: "version-test".to_string(),
            version: "1.0.0".to_string(),
            skill_name: skill_name.to_string(),
            display_name: skill_name.to_string(),
            content_hash: format!("sha256:{}", "1".repeat(64)),
            installed_at: "2026-01-01T00:00:00.000Z".to_string(),
            download_url: "data:application/zip;base64,".to_string(),
            package_sha256: format!("sha256:{}", sha256_hex(bytes)),
        }
    }

    #[test]
    fn installs_valid_package() {
        let root = tempfile::tempdir().unwrap();
        let bytes = create_package("test-skill", Some("test-skill"));
        let result =
            install_package_bytes(&input_for("test-skill", &bytes), &bytes, root.path()).unwrap();

        assert!(Path::new(&result.installed_path).join("SKILL.md").is_file());
        assert!(Path::new(&result.installed_path)
            .join("references/usage.md")
            .is_file());
    }

    #[test]
    fn rejects_existing_target_without_modifying_it() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("test-skill");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("original.txt"), "keep").unwrap();
        let bytes = create_package("test-skill", None);

        let error = install_package_bytes(&input_for("test-skill", &bytes), &bytes, root.path())
            .unwrap_err();

        assert_eq!(error.code, "LOCAL_SKILL_CONFLICT");
        assert_eq!(
            fs::read_to_string(target.join("original.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn rejects_package_hash_mismatch() {
        let root = tempfile::tempdir().unwrap();
        let bytes = create_package("test-skill", None);
        let mut input = input_for("test-skill", &bytes);
        input.package_sha256 = format!("sha256:{}", "0".repeat(64));

        let error = install_package_bytes(&input, &bytes, root.path()).unwrap_err();

        assert_eq!(error.code, "PACKAGE_HASH_MISMATCH");
        assert!(!root.path().join("test-skill").exists());
    }

    #[test]
    fn rejects_skill_name_mismatch() {
        let root = tempfile::tempdir().unwrap();
        let bytes = create_package("another-skill", None);

        let error = install_package_bytes(&input_for("test-skill", &bytes), &bytes, root.path())
            .unwrap_err();

        assert_eq!(error.code, "SKILL_NAME_MISMATCH");
        assert!(!root.path().join("test-skill").exists());
    }

    #[test]
    fn rejects_path_traversal() {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = ZipWriter::new(&mut cursor);
            let options = SimpleFileOptions::default();
            writer.start_file("SKILL.md", options).unwrap();
            writer
                .write_all(b"---\nname: test-skill\ndescription: test\n---\n")
                .unwrap();
            writer.start_file("../escape.txt", options).unwrap();
            writer.write_all(b"escape").unwrap();
            writer.finish().unwrap();
        }
        let bytes = cursor.into_inner();
        let root = tempfile::tempdir().unwrap();

        let error = install_package_bytes(&input_for("test-skill", &bytes), &bytes, root.path())
            .unwrap_err();

        assert_eq!(error.code, "INVALID_SKILL_PACKAGE");
        assert!(!root.path().join("test-skill").exists());
        assert!(!root.path().parent().unwrap().join("escape.txt").exists());
    }

    #[test]
    fn codex_toggle_only_changes_the_managed_connection() {
        let home = tempfile::tempdir().unwrap();
        let source = home
            .path()
            .join(".agents")
            .join("skills")
            .join("test-skill");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: test-skill\ndescription: test\n---\n",
        )
        .unwrap();
        let input = |enabled| SetLocalSkillEnabledInput {
            skill_name: "test-skill".to_string(),
            source_path: source.to_string_lossy().into_owned(),
            agent: "codex".to_string(),
            enabled,
        };

        let enabled_records = set_local_skill_enabled_at_home(home.path(), input(true)).unwrap();

        let codex_link = home.path().join(".codex").join("skills").join("test-skill");
        assert!(source.is_dir());
        assert!(!fs::symlink_metadata(&source)
            .unwrap()
            .file_type()
            .is_symlink());
        let codex_link_metadata = fs::symlink_metadata(&codex_link).unwrap();
        let codex_link_kind =
            managed_directory_link_kind(&codex_link, &codex_link_metadata).unwrap();
        #[cfg(unix)]
        assert_eq!(
            codex_link_kind,
            Some(ManagedDirectoryLinkKind::SymbolicLink)
        );
        #[cfg(windows)]
        assert!(matches!(
            codex_link_kind,
            Some(ManagedDirectoryLinkKind::SymbolicLink | ManagedDirectoryLinkKind::Junction)
        ));
        let codex_record = enabled_records
            .iter()
            .find(|record| record.location == "CODEX" && record.skill_name == "test-skill")
            .unwrap();
        #[cfg(unix)]
        assert_eq!(codex_record.entry_kind, "SYMLINK");
        #[cfg(unix)]
        assert!(
            load_local_skill_manager_state(home.path())
                .unwrap()
                .connections
                .is_empty(),
            "macOS/Linux 软连接不应写入 Windows 副本状态"
        );
        #[cfg(windows)]
        assert!(matches!(
            codex_record.entry_kind.as_str(),
            "SYMLINK" | "JUNCTION"
        ));
        assert_eq!(
            codex_link.canonicalize().unwrap(),
            source.canonicalize().unwrap()
        );

        set_local_skill_enabled_at_home(home.path(), input(false)).unwrap();

        assert!(source.is_dir());
        assert!(matches!(
            fs::symlink_metadata(&codex_link),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        ));
    }

    #[test]
    fn managed_copy_is_grouped_with_its_source_and_removed_safely() {
        let home = tempfile::tempdir().unwrap();
        let source = home
            .path()
            .join(".agents")
            .join("skills")
            .join("test-skill");
        let target = home.path().join(".codex").join("skills").join("test-skill");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: test-skill\ndescription: source\n---\n",
        )
        .unwrap();
        copy_skill_directory(&source, &target).unwrap();
        let state_path = local_skill_manager_state_path(home.path());
        fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        fs::write(
            &state_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "assignments": {
                    "codex": ["test-skill"]
                },
                "connections": {
                    "codex:test-skill": {
                        "sourcePath": source,
                        "mode": "copy",
                        "sourceHash": "sha256:test"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let records = scan_local_skills_from_home(home.path()).unwrap();
        let copied_record = records
            .iter()
            .find(|record| record.location == "CODEX" && record.skill_name == "test-skill")
            .unwrap();
        assert_eq!(copied_record.entry_kind, "COPY");
        assert_eq!(
            PathBuf::from(&copied_record.resolved_path),
            source.canonicalize().unwrap()
        );

        set_local_skill_enabled_at_home(
            home.path(),
            SetLocalSkillEnabledInput {
                skill_name: "test-skill".to_string(),
                source_path: source.to_string_lossy().into_owned(),
                agent: "codex".to_string(),
                enabled: false,
            },
        )
        .unwrap();

        assert!(source.join("SKILL.md").is_file());
        assert!(!target.exists());
        let state = fs::read_to_string(state_path).unwrap();
        assert!(!state.contains("codex:test-skill"));
    }

    #[test]
    fn scanning_refreshes_a_managed_copy_when_the_source_changes() {
        let home = tempfile::tempdir().unwrap();
        let source = home
            .path()
            .join(".agents")
            .join("skills")
            .join("test-skill");
        let target = home.path().join(".codex").join("skills").join("test-skill");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: test-skill\ndescription: stale\n---\n",
        )
        .unwrap();
        copy_skill_directory(&source, &target).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: test-skill\ndescription: updated\n---\n",
        )
        .unwrap();
        let state_path = local_skill_manager_state_path(home.path());
        fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        fs::write(
            &state_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "assignments": {
                    "codex": ["test-skill"]
                },
                "connections": {
                    "codex:test-skill": {
                        "sourcePath": source,
                        "mode": "copy",
                        "sourceHash": "sha256:stale"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        scan_local_skills_from_home(home.path()).unwrap();

        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "---\nname: test-skill\ndescription: updated\n---\n"
        );
        let saved_state = load_local_skill_manager_state(home.path()).unwrap();
        let saved_connection = saved_state.connections.get("codex:test-skill").unwrap();
        assert_eq!(
            saved_connection.source_hash,
            hash_skill_directory(&source).unwrap()
        );
    }

    #[test]
    fn disabling_never_removes_an_unmarked_directory_claimed_by_stale_state() {
        let home = tempfile::tempdir().unwrap();
        let source = home
            .path()
            .join(".agents")
            .join("skills")
            .join("test-skill");
        let target = home.path().join(".codex").join("skills").join("test-skill");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: test-skill\ndescription: source\n---\n",
        )
        .unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(
            target.join("SKILL.md"),
            "---\nname: test-skill\ndescription: independent\n---\n",
        )
        .unwrap();
        fs::write(target.join("keep.txt"), "keep").unwrap();
        let state_path = local_skill_manager_state_path(home.path());
        fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        fs::write(
            state_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "assignments": {
                    "codex": ["test-skill"]
                },
                "connections": {
                    "codex:test-skill": {
                        "sourcePath": source,
                        "targetPath": target,
                        "mode": "copy",
                        "sourceHash": "sha256:stale"
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let error = set_local_skill_enabled_at_home(
            home.path(),
            SetLocalSkillEnabledInput {
                skill_name: "test-skill".to_string(),
                source_path: source.to_string_lossy().into_owned(),
                agent: "codex".to_string(),
                enabled: false,
            },
        )
        .unwrap_err();

        assert_eq!(error.code, "LOCAL_SKILL_NOT_MANAGED_LINK");
        assert_eq!(fs::read_to_string(target.join("keep.txt")).unwrap(), "keep");
    }

    #[cfg(windows)]
    #[test]
    fn windows_connection_falls_back_from_symlink_to_junction_to_copy() {
        use std::{cell::RefCell, rc::Rc};

        let attempts = Rc::new(RefCell::new(Vec::new()));
        let symlink_attempts = Rc::clone(&attempts);
        let junction_attempts = Rc::clone(&attempts);
        let copy_attempts = Rc::clone(&attempts);

        let mode = create_windows_managed_connection_with(
            || {
                symlink_attempts.borrow_mut().push("symlink");
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "developer mode disabled",
                ))
            },
            || {
                junction_attempts.borrow_mut().push("junction");
                Err(std::io::Error::other("remote path"))
            },
            || {
                copy_attempts.borrow_mut().push("copy");
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(mode, ManagedConnectionMode::Copy);
        assert_eq!(&*attempts.borrow(), &["symlink", "junction", "copy"]);
    }
}
