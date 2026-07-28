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
    let metadata_bytes = serde_json::to_vec_pretty(&install_metadata)
        .map_err(|error| {
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

fn scan_skills_root(root: &Path, records: &mut Vec<LocalSkillRecord>) {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            warn!("读取本地 Skill 根目录失败：root={}, error={error}", root.display());
            return;
        }
    };

    for entry in entries.flatten() {
        let directory_name = entry.file_name().to_string_lossy().into_owned();
        if directory_name.starts_with('.') {
            continue;
        }
        let skill_path = entry.path();
        let is_directory = entry
            .file_type()
            .map(|file_type| file_type.is_dir() || file_type.is_symlink())
            .unwrap_or(false);
        if !is_directory || !skill_path.join("SKILL.md").is_file() {
            continue;
        }
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
        let skill_name = parse_skill_name(&skill_md)
            .unwrap_or_else(|_| directory_name.clone());
        let metadata = fs::read_to_string(
            skill_path.join(INSTALL_METADATA_FILE),
        )
        .ok()
        .and_then(|content| {
            serde_json::from_str::<InstalledSkillMetadata>(&content).ok()
        })
        .filter(|metadata| {
            metadata.schema_version == 1 &&
                metadata.skill_name == skill_name
        });
        let path_text = skill_path.to_string_lossy().into_owned();
        let local_id_hash = sha256_hex(path_text.as_bytes());
        let skill_md_hash = sha256_hex(skill_md.as_bytes());
        let (
            skill_id,
            version_id,
            version,
            display_name,
            content_hash,
            installed_at,
            status,
        ) = match metadata {
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
        });
    }
}

fn scan_local_skills_from_disk() -> Result<Vec<LocalSkillRecord>, InstallError> {
    let home = dirs::home_dir().ok_or_else(|| {
        InstallError::new("HOME_DIRECTORY_UNAVAILABLE", "无法获取当前用户主目录")
    })?;
    let roots = [
        home.join(".agents").join("skills"),
        home.join(".claude").join("skills"),
        home.join(".codex").join("skills"),
    ];
    let mut records = Vec::new();
    for root in roots {
        scan_skills_root(&root, &mut records);
    }
    records.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
            .then_with(|| left.install_path.cmp(&right.install_path))
    });
    Ok(records)
}

/** 只读扫描通用 Agents、Claude Code 与 Codex Skill 目录。 */
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
}
