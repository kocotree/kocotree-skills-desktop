use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::Builder as TempDirBuilder;
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const MAX_PACKAGE_SIZE: usize = 50 * 1024 * 1024;
const MAX_FILE_COUNT: usize = 2_000;
const MAX_UNCOMPRESSED_SIZE: u64 = 200 * 1024 * 1024;
const MAX_SKILL_MD_SIZE: u64 = 1024 * 1024;
const INSTALL_METADATA_FILE: &str = ".kocotree-skill.json";
const MANAGER_STATE_FILE: &str = ".kocotree-skills-desktop.json";
const MANAGED_COPY_METADATA_FILE: &str = ".kocotree-managed-copy.json";
const KOCOTREE_SKILLS_DIRECTORY: &str = ".kocotree-skills";
const LEGACY_KOCOTREE_SKILLS_DIRECTORY: &str = ".skills-manager";

fn kocotree_skills_root(home: &Path) -> PathBuf {
    home.join(KOCOTREE_SKILLS_DIRECTORY)
}

fn private_skills_root(home: &Path) -> PathBuf {
    kocotree_skills_root(home).join("skills")
}

fn private_backups_root(home: &Path) -> PathBuf {
    kocotree_skills_root(home).join("backups")
}

fn external_skills_manager_root(home: &Path) -> PathBuf {
    home.join(LEGACY_KOCOTREE_SKILLS_DIRECTORY).join("skills")
}

fn shared_skills_root(home: &Path) -> PathBuf {
    home.join(".agents").join("skills")
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSkillInput {
    pub skill_id: String,
    pub version_id: String,
    pub version: String,
    pub skill_name: String,
    pub display_name: String,
    pub display_description: String,
    pub content_hash: String,
    pub installed_at: String,
    pub download_url: String,
    pub package_sha256: String,
    #[serde(default)]
    pub force: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledSkillMetadata {
    schema_version: u8,
    skill_id: String,
    version_id: String,
    version: String,
    skill_name: String,
    display_name: String,
    #[serde(default)]
    display_description: String,
    content_hash: String,
    installed_at: String,
    #[serde(default)]
    origin: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSkillResult {
    pub installed_path: String,
    pub replaced_skill_name: Option<String>,
    pub backup_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallationStatus {
    pub claude: bool,
}

fn command_exists_in_directory(directory: &Path, command: &str) -> bool {
    #[cfg(windows)]
    {
        ["", ".exe", ".cmd", ".bat", ".ps1"]
            .iter()
            .any(|suffix| directory.join(format!("{command}{suffix}")).is_file())
    }
    #[cfg(not(windows))]
    {
        directory.join(command).is_file()
    }
}

fn command_exists_on_path(command: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path)
            .any(|directory| command_exists_in_directory(&directory, command))
    })
}

fn nvm_has_command(home: &Path, command: &str) -> bool {
    let versions_root = home.join(".nvm").join("versions").join("node");
    fs::read_dir(versions_root).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| command_exists_in_directory(&entry.path().join("bin"), command))
    })
}

#[cfg(windows)]
fn windows_nvm_has_command(command: &str) -> bool {
    let mut roots = ["NVM_SYMLINK", "NVM_HOME"]
        .iter()
        .filter_map(|key| std::env::var_os(key).map(PathBuf::from))
        .collect::<Vec<_>>();
    if let Some(app_data) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(app_data).join("nvm"));
    }

    roots.iter().any(|root| {
        command_exists_in_directory(root, command)
            || fs::read_dir(root).is_ok_and(|entries| {
                entries
                    .flatten()
                    .filter(|entry| entry.path().is_dir())
                    .any(|entry| command_exists_in_directory(&entry.path(), command))
            })
    })
}

#[cfg(windows)]
fn windows_claude_command_directories(home: &Path) -> Vec<PathBuf> {
    let mut directories = vec![
        home.join(".local").join("bin"),
        home.join(".claude").join("local"),
        home.join(".npm-global").join("bin"),
        home.join(".bun").join("bin"),
        home.join(".volta").join("bin"),
    ];

    if let Some(app_data) = std::env::var_os("APPDATA") {
        let app_data = PathBuf::from(app_data);
        directories.push(app_data.join("npm"));
        directories.push(app_data.join("pnpm"));
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let local_app_data = PathBuf::from(local_app_data);
        directories.push(local_app_data.join("Microsoft").join("WindowsApps"));
        directories.push(local_app_data.join("pnpm"));
        directories.push(local_app_data.join("Volta").join("bin"));
        directories.push(local_app_data.join("Programs").join("claude"));
        directories.push(
            local_app_data
                .join("Programs")
                .join("Claude Code")
                .join("bin"),
        );
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        directories.push(PathBuf::from(program_files).join("nodejs"));
    }
    if let Some(prefix) = std::env::var_os("npm_config_prefix") {
        directories.push(PathBuf::from(prefix));
    }
    for key in ["NVM_HOME", "NVM_SYMLINK", "FNM_MULTISHELL_PATH"] {
        if let Some(path) = std::env::var_os(key) {
            directories.push(PathBuf::from(path));
        }
    }

    directories
}

fn claude_code_is_installed(home: &Path) -> bool {
    if command_exists_on_path("claude") || nvm_has_command(home, "claude") {
        return true;
    }

    let directories = vec![
        home.join(".local").join("bin"),
        home.join(".claude").join("local"),
        home.join(".npm-global").join("bin"),
        home.join(".bun").join("bin"),
        home.join(".local").join("share").join("pnpm"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ];
    #[cfg(windows)]
    let directories = {
        let mut directories = directories;
        if windows_nvm_has_command("claude") {
            return true;
        }
        directories.extend(windows_claude_command_directories(home));
        directories
    };

    directories
        .iter()
        .any(|directory| command_exists_in_directory(directory, "claude"))
}

#[tauri::command]
pub fn get_agent_installation_status() -> AgentInstallationStatus {
    let claude = dirs::home_dir()
        .as_deref()
        .is_some_and(claude_code_is_installed);
    AgentInstallationStatus { claude }
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
    pub display_description: String,
    pub skill_description: String,
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveLocalSkillInput {
    pub skill_id: String,
    pub skill_name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveLocalSkillEntriesInput {
    pub record_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordLocalSkillPublicationInput {
    pub source_path: String,
    pub skill_id: String,
    pub version_id: String,
    pub version: String,
    pub skill_name: String,
    pub display_name: String,
    pub display_description: String,
    pub content_hash: String,
    pub synced_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncLocalSkillMetadataInput {
    pub skill_id: String,
    pub display_name: String,
    pub display_description: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalSkillManagerState {
    schema_version: u32,
    assignments: HashMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    connections: HashMap<String, ManagedConnectionState>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    legacy_sources: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    publications: HashMap<String, InstalledSkillMetadata>,
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

fn parse_skill_frontmatter(skill_md: &str) -> Result<serde_yaml::Value, InstallError> {
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
    serde_yaml::from_str(&frontmatter[..end_index]).map_err(|_| {
        InstallError::new(
            "INVALID_SKILL_PACKAGE",
            "SKILL.md 的 YAML frontmatter 无法解析",
        )
    })
}

fn parse_skill_name(skill_md: &str) -> Result<String, InstallError> {
    let yaml = parse_skill_frontmatter(skill_md)?;
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

fn parse_skill_description(skill_md: &str) -> String {
    parse_skill_frontmatter(skill_md)
        .ok()
        .and_then(|yaml| {
            yaml.get("description")
                .and_then(serde_yaml::Value::as_str)
                .map(str::trim)
                .filter(|description| !description.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_default()
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

fn next_backup_path(backups_root: &Path, skill_name: &str) -> Result<PathBuf, InstallError> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let base_name = format!("{skill_name}-{timestamp}");
    for suffix in 0_u32.. {
        let file_name = if suffix == 0 {
            base_name.clone()
        } else {
            format!("{base_name}-{suffix}")
        };
        let candidate = backups_root.join(file_name);
        match fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(candidate);
            }
            Err(error) => return Err(io_error("检查 Skill 备份目录", error)),
        }
    }
    unreachable!("备份目录后缀空间已耗尽")
}

/**
 * 功能说明：把已下载并校验的 ZIP 安装到指定 Skill 根目录，并在用户确认后备份替换已有目录。
 * 参数：
 * - `input`：目标 Skill、版本、下载地址和包哈希。
 * - `package_bytes`：完整 ZIP 字节。
 * - `skills_root`：平台解析后的 Skill 安装根目录。
 * - `backups_root`：覆盖前保存原 Skill 的备份根目录。
 *
 * 返回值：最终安装路径和可选备份路径；未确认冲突或校验失败时不修改已有目录。
 */
fn install_package_bytes(
    input: &InstallSkillInput,
    package_bytes: &[u8],
    skills_root: &Path,
    backups_root: &Path,
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
    let target_exists = match fs::symlink_metadata(&target) {
        Ok(_) => {
            if input.force {
                true
            } else {
                warn!("Skill 安装等待覆盖确认：skill_name={}", input.skill_name);
                return Err(InstallError::with_details(
                    "LOCAL_SKILL_CONFLICT",
                    "本地已存在同名 Skill，请确认是否覆盖安装",
                    serde_json::json!({
                        "targetPath": target,
                        "forceSupported": true,
                    }),
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(io_error("检查目标 Skill 目录", error)),
    };

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
        display_description: input.display_description.clone(),
        content_hash: input.content_hash.clone(),
        installed_at: input.installed_at.clone(),
        origin: Some("INSTALLED".to_string()),
    };
    let metadata_bytes = serde_json::to_vec_pretty(&install_metadata).map_err(|error| {
        InstallError::new(
            "LOCAL_INSTALL_METADATA_ERROR",
            format!("生成安装元数据失败：{error}"),
        )
    })?;
    fs::write(payload.join(INSTALL_METADATA_FILE), metadata_bytes)
        .map_err(|error| io_error("写入安装元数据", error))?;

    let backup_path = if target_exists {
        fs::create_dir_all(backups_root).map_err(|error| io_error("创建 Skill 备份目录", error))?;
        let backup_path = next_backup_path(backups_root, &input.skill_name)?;
        fs::rename(&target, &backup_path).map_err(|error| io_error("备份原 Skill 目录", error))?;
        Some(backup_path)
    } else {
        None
    };

    if let Err(write_error) = fs::rename(&payload, &target) {
        if let Some(backup_path) = &backup_path {
            return match fs::rename(backup_path, &target) {
                Ok(()) => Err(InstallError::with_details(
                    "INSTALL_ROLLBACK_COMPLETED",
                    "新版本写入失败，原 Skill 已自动恢复",
                    serde_json::json!({
                        "targetPath": target,
                        "cause": write_error.to_string(),
                    }),
                )),
                Err(rollback_error) => Err(InstallError::with_details(
                    "INSTALL_ROLLBACK_FAILED",
                    "新版本写入失败，原 Skill 也未能自动恢复",
                    serde_json::json!({
                        "targetPath": target,
                        "backupPath": backup_path,
                        "installCause": write_error.to_string(),
                        "rollbackCause": rollback_error.to_string(),
                    }),
                )),
            };
        }
        return Err(io_error("写入 Skill 目录", write_error));
    }

    if target_exists {
        info!(
            "Skill 已覆盖安装并保留备份：skill_name={}, backup_path={}",
            input.skill_name,
            backup_path.as_deref().unwrap_or(backups_root).display()
        );
    }

    Ok(InstallSkillResult {
        installed_path: target.to_string_lossy().into_owned(),
        replaced_skill_name: target_exists.then(|| input.skill_name.clone()),
        backup_path: backup_path.map(|path| path.to_string_lossy().into_owned()),
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
        let skills_root = private_skills_root(&home);
        let backups_root = private_backups_root(&home);
        install_package_bytes(&input, &package_bytes, &skills_root, &backups_root)
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
        let skill_description = parse_skill_description(&skill_md);
        let metadata = fs::read_to_string(skill_path.join(INSTALL_METADATA_FILE))
            .ok()
            .and_then(|content| serde_json::from_str::<InstalledSkillMetadata>(&content).ok())
            .filter(|metadata| metadata.schema_version == 1 && metadata.skill_name == skill_name);
        let path_text = skill_path.to_string_lossy().into_owned();
        let local_id_hash = sha256_hex(path_text.as_bytes());
        let skill_md_hash = sha256_hex(skill_md.as_bytes());
        let (
            skill_id,
            version_id,
            version,
            display_name,
            display_description,
            content_hash,
            installed_at,
            status,
        ) = match metadata {
            Some(metadata) => (
                Some(metadata.skill_id),
                Some(metadata.version_id),
                Some(metadata.version),
                metadata.display_name,
                metadata.display_description,
                metadata.content_hash,
                Some(metadata.installed_at),
                if metadata.origin.as_deref() == Some("PUBLISHED") {
                    "PLATFORM_MATCHED".to_string()
                } else {
                    "PLATFORM_INSTALLED".to_string()
                },
            ),
            None => (
                None,
                None,
                None,
                skill_name.clone(),
                String::new(),
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
            display_description,
            skill_description,
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
        legacy_sources: HashMap::new(),
        publications: HashMap::new(),
    }
}

fn local_skill_manager_state_path(home: &Path) -> PathBuf {
    kocotree_skills_root(home).join(MANAGER_STATE_FILE)
}

fn legacy_local_skill_manager_state_path(home: &Path) -> PathBuf {
    home.join(LEGACY_KOCOTREE_SKILLS_DIRECTORY)
        .join(MANAGER_STATE_FILE)
}

fn parse_local_skill_manager_state(
    content: &str,
) -> Result<LocalSkillManagerState, InstallError> {
    let state = serde_json::from_str::<LocalSkillManagerState>(content).map_err(|_| {
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

fn write_local_skill_manager_state(
    state_path: &Path,
    state: &LocalSkillManagerState,
) -> Result<(), InstallError> {
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

fn load_local_skill_manager_state(home: &Path) -> Result<LocalSkillManagerState, InstallError> {
    let state_path = local_skill_manager_state_path(home);
    match fs::read_to_string(&state_path) {
        Ok(content) => return parse_local_skill_manager_state(&content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error("读取 Skill 管理状态", error)),
    }

    let legacy_state_path = legacy_local_skill_manager_state_path(home);
    let legacy_content = match fs::read_to_string(&legacy_state_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(empty_local_skill_manager_state());
        }
        Err(error) => return Err(io_error("读取旧版 Skill 管理状态", error)),
    };
    let state = parse_local_skill_manager_state(&legacy_content)?;
    if let Err(error) = write_local_skill_manager_state(&state_path, &state) {
        warn!(
            "迁移旧版 Skill 管理状态失败，继续使用内存状态：from={}, to={}, code={}, message={}",
            legacy_state_path.display(),
            state_path.display(),
            error.code,
            error.message
        );
    } else {
        info!(
            "旧版 Skill 管理状态已复制到 Kocotree 私有目录：from={}, to={}",
            legacy_state_path.display(),
            state_path.display()
        );
    }
    Ok(state)
}

fn save_local_skill_manager_state(
    home: &Path,
    state: &LocalSkillManagerState,
) -> Result<(), InstallError> {
    write_local_skill_manager_state(&local_skill_manager_state_path(home), state)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodexSkillConfigState {
    Missing,
    Enabled,
    Disabled,
}

fn codex_config_path(home: &Path) -> PathBuf {
    home.join(".codex").join("config.toml")
}

fn write_codex_config(path: &Path, content: &str) -> Result<(), InstallError> {
    if !content.trim().is_empty() {
        toml::from_str::<toml::Value>(content).map_err(|error| {
            InstallError::new(
                "LOCAL_SKILL_CODEX_CONFIG_INVALID",
                format!("修改后的 Codex 配置无效，未保存：{error}"),
            )
        })?;
    }
    let parent = path.parent().ok_or_else(|| {
        InstallError::new("LOCAL_SKILL_CODEX_CONFIG_INVALID", "Codex 配置路径无效")
    })?;
    fs::create_dir_all(parent).map_err(|error| io_error("创建 Codex 配置目录", error))?;
    let existing_permissions = fs::metadata(path).ok().map(|metadata| metadata.permissions());
    let mut temporary = TempDirBuilder::new()
        .prefix(".kocotree-codex-config-")
        .tempfile_in(parent)
        .map_err(|error| io_error("创建 Codex 配置临时文件", error))?;
    if let Some(permissions) = existing_permissions {
        temporary
            .as_file()
            .set_permissions(permissions)
            .map_err(|error| io_error("保留 Codex 配置权限", error))?;
    }
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| io_error("写入 Codex 配置临时文件", error))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| io_error("同步 Codex 配置", error))?;
    temporary
        .persist(path)
        .map_err(|error| io_error("保存 Codex 配置", error.error))?;
    Ok(())
}

fn skill_definition_path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn codex_skill_config_state(
    content: &str,
    skill_definition_path: &str,
) -> Result<CodexSkillConfigState, InstallError> {
    if content.trim().is_empty() {
        return Ok(CodexSkillConfigState::Missing);
    }
    let config = toml::from_str::<toml::Value>(content).map_err(|error| {
        InstallError::new(
            "LOCAL_SKILL_CODEX_CONFIG_INVALID",
            format!("Codex 配置文件格式无效，未进行修改：{error}"),
        )
    })?;
    let Some(entries) = config
        .get("skills")
        .and_then(|skills| skills.get("config"))
        .and_then(toml::Value::as_array)
    else {
        return Ok(CodexSkillConfigState::Missing);
    };

    let mut state = CodexSkillConfigState::Missing;
    for entry in entries {
        let Some(path) = entry.get("path").and_then(toml::Value::as_str) else {
            continue;
        };
        if skill_definition_path_text(Path::new(path)) != skill_definition_path {
            continue;
        }
        if entry
            .get("enabled")
            .and_then(toml::Value::as_bool)
            == Some(false)
        {
            return Ok(CodexSkillConfigState::Disabled);
        }
        state = CodexSkillConfigState::Enabled;
    }
    Ok(state)
}

fn managed_codex_config_markers(skill_definition_path: &str) -> (String, String) {
    let marker_id = sha256_hex(skill_definition_path.as_bytes());
    (
        format!("# kocotree-managed-skill:begin {marker_id}"),
        format!("# kocotree-managed-skill:end {marker_id}"),
    )
}

fn remove_managed_codex_config_block(
    content: &str,
    skill_definition_path: &str,
) -> Option<String> {
    let (begin_marker, end_marker) = managed_codex_config_markers(skill_definition_path);
    let begin = content.find(&begin_marker)?;
    let block_start = content[..begin].rfind('\n').map_or(0, |index| index + 1);
    let end_marker_start = content[begin..].find(&end_marker)? + begin;
    let block_end = content[end_marker_start..]
        .find('\n')
        .map_or(content.len(), |index| end_marker_start + index + 1);
    let mut updated = String::with_capacity(content.len() - (block_end - block_start));
    updated.push_str(&content[..block_start]);
    updated.push_str(&content[block_end..]);
    Some(updated)
}

fn external_codex_skill_definition_paths(
    home: &Path,
    source: &Path,
) -> Result<Vec<String>, InstallError> {
    let mut paths = vec![skill_definition_path_text(&source.join("SKILL.md"))];
    let Some(directory_name) = source.file_name() else {
        return Ok(paths);
    };
    let legacy_entry = home
        .join(".codex")
        .join("skills")
        .join(directory_name);
    let metadata = match fs::symlink_metadata(&legacy_entry) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(paths),
        Err(error) => return Err(io_error("检查旧版 Codex Skill 连接", error)),
    };
    let link_kind = managed_directory_link_kind(&legacy_entry, &metadata)
        .map_err(|error| io_error("检查旧版 Codex Skill 连接", error))?;
    if link_kind.is_some()
        && legacy_entry
            .canonicalize()
            .is_ok_and(|target| target == source)
    {
        paths.push(skill_definition_path_text(&legacy_entry.join("SKILL.md")));
    }
    Ok(paths)
}

fn potential_external_codex_definition_path(home: &Path, source: &Path) -> Option<String> {
    Some(skill_definition_path_text(
        &home
            .join(".codex")
            .join("skills")
            .join(source.file_name()?)
            .join("SKILL.md"),
    ))
}

fn set_external_codex_skill_enabled(
    home: &Path,
    source: &Path,
    enabled: bool,
) -> Result<(), InstallError> {
    let config_path = codex_config_path(home);
    let mut content = match fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(io_error("读取 Codex 配置", error)),
    };
    let mut skill_definition_paths = external_codex_skill_definition_paths(home, source)?;
    if let Some(legacy_path) = potential_external_codex_definition_path(home, source) {
        let (begin_marker, end_marker) = managed_codex_config_markers(&legacy_path);
        if (content.contains(&begin_marker) || content.contains(&end_marker))
            && !skill_definition_paths.contains(&legacy_path)
        {
            skill_definition_paths.push(legacy_path);
        }
    }

    if enabled {
        let original_content = content.clone();
        for skill_definition_path in &skill_definition_paths {
            let (begin_marker, end_marker) =
                managed_codex_config_markers(skill_definition_path);
            let has_begin = content.contains(&begin_marker);
            let has_end = content.contains(&end_marker);
            if has_begin != has_end {
                return Err(InstallError::new(
                    "LOCAL_SKILL_CODEX_CONFIG_INVALID",
                    "管理器写入的 Codex Skill 配置不完整，未进行修改",
                ));
            }
            if has_begin {
                content = remove_managed_codex_config_block(
                    &content,
                    skill_definition_path,
                )
                .ok_or_else(|| {
                    InstallError::new(
                        "LOCAL_SKILL_CODEX_CONFIG_INVALID",
                        "管理器写入的 Codex Skill 配置不完整，未进行修改",
                    )
                })?;
            }
        }
        for skill_definition_path in &skill_definition_paths {
            if codex_skill_config_state(&content, skill_definition_path)?
                == CodexSkillConfigState::Disabled
            {
                return Err(InstallError::new(
                    "LOCAL_SKILL_CODEX_CONFIG_UNMANAGED",
                    "该 Skill 仍被用户自己的 Codex 配置关闭，请先处理该配置",
                ));
            }
        }
        if content == original_content {
            return Ok(());
        }
    } else {
        let mut paths_to_disable = Vec::new();
        for skill_definition_path in &skill_definition_paths {
            let (begin_marker, end_marker) =
                managed_codex_config_markers(skill_definition_path);
            let has_begin = content.contains(&begin_marker);
            let has_end = content.contains(&end_marker);
            if has_begin != has_end {
                return Err(InstallError::new(
                    "LOCAL_SKILL_CODEX_CONFIG_INVALID",
                    "管理器写入的 Codex Skill 配置不完整，未进行修改",
                ));
            }
            if has_begin {
                continue;
            }
            match codex_skill_config_state(&content, skill_definition_path)? {
                CodexSkillConfigState::Disabled => continue,
                CodexSkillConfigState::Enabled => {
                    return Err(InstallError::new(
                        "LOCAL_SKILL_CODEX_CONFIG_CONFLICT",
                        "Codex 配置中已有该 Skill 的启用项，未进行覆盖",
                    ));
                }
                CodexSkillConfigState::Missing => {
                    paths_to_disable.push(skill_definition_path);
                }
            }
        }
        if paths_to_disable.is_empty() {
            return Ok(());
        }
        for skill_definition_path in paths_to_disable {
            if !content.is_empty() && !content.ends_with('\n') {
                content.push('\n');
            }
            if !content.is_empty() && !content.ends_with("\n\n") {
                content.push('\n');
            }
            let (begin_marker, end_marker) =
                managed_codex_config_markers(skill_definition_path);
            let quoted_path = serde_json::to_string(skill_definition_path).map_err(|_| {
                InstallError::new(
                    "LOCAL_SKILL_CODEX_CONFIG_INVALID",
                    "无法生成 Codex Skill 配置",
                )
            })?;
            content.push_str(&begin_marker);
            content.push('\n');
            content.push_str("[[skills.config]]\npath = ");
            content.push_str(&quoted_path);
            content.push_str("\nenabled = false\n");
            content.push_str(&end_marker);
            content.push('\n');
        }
    }

    write_codex_config(&config_path, &content)
}

fn remove_owned_codex_disable_for_path(
    home: &Path,
    skill_definition_path: &str,
) -> Result<(), InstallError> {
    let config_path = codex_config_path(home);
    let content = match fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error("读取 Codex 配置", error)),
    };
    let Some(updated) = remove_managed_codex_config_block(&content, skill_definition_path) else {
        return Ok(());
    };
    write_codex_config(&config_path, &updated)
}

fn codex_disabled_skill_paths(home: &Path) -> Result<HashSet<String>, InstallError> {
    let content = match fs::read_to_string(codex_config_path(home)) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(error) => return Err(io_error("读取 Codex 配置", error)),
    };
    if content.trim().is_empty() {
        return Ok(HashSet::new());
    }
    let config = toml::from_str::<toml::Value>(&content).map_err(|error| {
        InstallError::new(
            "LOCAL_SKILL_CODEX_CONFIG_INVALID",
            format!("Codex 配置文件格式无效：{error}"),
        )
    })?;
    let disabled = config
        .get("skills")
        .and_then(|skills| skills.get("config"))
        .and_then(toml::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| {
            entry
                .get("enabled")
                .and_then(toml::Value::as_bool)
                == Some(false)
        })
        .filter_map(|entry| entry.get("path").and_then(toml::Value::as_str))
        .map(|path| skill_definition_path_text(Path::new(path)))
        .collect();
    Ok(disabled)
}

#[cfg(any(windows, test))]
fn refresh_managed_copies(home: &Path) -> Result<(), InstallError> {
    let mut state = load_local_skill_manager_state(home)?;
    let allowed_source_roots = [private_skills_root(home)]
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

fn apply_managed_publication(
    record: &mut LocalSkillRecord,
    metadata: &InstalledSkillMetadata,
) {
    if metadata.schema_version != 1 || metadata.skill_name != record.skill_name {
        return;
    }
    record.skill_id = Some(metadata.skill_id.clone());
    record.version_id = Some(metadata.version_id.clone());
    record.version = Some(metadata.version.clone());
    record.display_name = metadata.display_name.clone();
    record.display_description = metadata.display_description.clone();
    record.content_hash = metadata.content_hash.clone();
    record.installed_at = Some(metadata.installed_at.clone());
    record.status = "PLATFORM_MATCHED".to_string();
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
        ("MANAGER", private_skills_root(home)),
        ("EXTERNAL", external_skills_manager_root(home)),
        ("AGENTS", shared_skills_root(home)),
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
    for record in &mut records {
        if let Some(metadata) = manager_state.publications.get(&record.resolved_path) {
            apply_managed_publication(record, metadata);
        }
    }
    let disabled_codex_skills = codex_disabled_skill_paths(home).unwrap_or_else(|error| {
        warn!(
            "读取 Codex Skill 开关状态失败，按开启状态继续：code={}, message={}",
            error.code, error.message
        );
        HashSet::new()
    });
    let mut legacy_codex_paths_by_source = HashMap::<String, Vec<String>>::new();
    for record in records.iter().filter(|record| {
        record.location == "CODEX"
            && matches!(record.entry_kind.as_str(), "SYMLINK" | "JUNCTION")
    }) {
        legacy_codex_paths_by_source
            .entry(record.resolved_path.clone())
            .or_default()
            .push(skill_definition_path_text(
                &PathBuf::from(&record.install_path).join("SKILL.md"),
            ));
    }
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
    for record in records.iter_mut().filter(|record| record.location == "MANAGER") {
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
    for record in records.iter_mut().filter(|record| record.location == "AGENTS") {
        let mut discovered_paths = vec![skill_definition_path_text(
            &PathBuf::from(&record.install_path).join("SKILL.md"),
        )];
        if let Some(legacy_paths) = legacy_codex_paths_by_source.get(&record.resolved_path) {
            discovered_paths.extend(legacy_paths.iter().cloned());
        }
        if discovered_paths
            .iter()
            .any(|path| !disabled_codex_skills.contains(path))
        {
            record.assigned_agents.push("codex".to_string());
        }
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
    if input.enabled && input.agent == "claude" && !claude_code_is_installed(home) {
        return Err(InstallError::new(
            "LOCAL_SKILL_AGENT_NOT_INSTALLED",
            "未检测到 Claude Code，安装后才能开启 Skill",
        ));
    }
    let requested_source_path = PathBuf::from(&input.source_path);
    let source_path = if requested_source_path.exists() {
        requested_source_path
    } else {
        private_skills_root(home).join(&input.skill_name)
    };
    let canonical_source = source_path.canonicalize().map_err(|error| {
        InstallError::new(
            "LOCAL_SKILL_SOURCE_MISSING",
            format!("Skill 本体不存在：{error}"),
        )
    })?;
    let private_root = private_skills_root(home).canonicalize().ok();
    let shared_root = shared_skills_root(home).canonicalize().ok();
    let source_is_private = private_root
        .as_ref()
        .is_some_and(|root| canonical_source.parent() == Some(root.as_path()));
    let source_is_shared = shared_root
        .as_ref()
        .is_some_and(|root| canonical_source.parent() == Some(root.as_path()));
    if (!source_is_private && !source_is_shared) || !canonical_source.join("SKILL.md").is_file() {
        return Err(InstallError::new(
            "LOCAL_SKILL_SOURCE_UNMANAGED",
            "只能控制管理器仓库或 .agents/skills 中的实体 Skill",
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
    // Codex 原生读取 .agents/skills 并通过配置启停；Claude Code 需要继续走
    // 下方的受管入口流程，在 ~/.claude/skills 中创建或移除连接。
    if source_is_shared && input.agent == "codex" {
        set_external_codex_skill_enabled(home, &canonical_source, input.enabled)?;
        return scan_local_skills_from_home(home);
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
                                "目标位置已有指向外部或其他 Skill 的连接，请先单独清理该连接",
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

    if input.enabled {
        let assigned_skills = manager_state
            .assignments
            .entry(input.agent.clone())
            .or_default();
        if !assigned_skills.iter().any(|name| name == &input.skill_name) {
            assigned_skills.push(input.skill_name);
            assigned_skills.sort();
            manager_state_changed = true;
        }
    } else {
        let remove_empty_assignment =
            if let Some(assigned_skills) = manager_state.assignments.get_mut(&input.agent) {
                let previous_length = assigned_skills.len();
                assigned_skills.retain(|name| name != &input.skill_name);
                manager_state_changed |= assigned_skills.len() != previous_length;
                assigned_skills.is_empty()
            } else {
                false
            };
        if remove_empty_assignment {
            manager_state.assignments.remove(&input.agent);
        }
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

#[derive(Clone, Copy, Debug)]
enum LocalRemovalKind {
    ManagedLink(ManagedDirectoryLinkKind),
    Directory,
}

fn uninstall_io_error(action: &str, error: std::io::Error) -> InstallError {
    InstallError::new("LOCAL_UNINSTALL_IO_ERROR", format!("{action}失败：{error}"))
}

#[cfg(target_os = "macos")]
fn move_local_skill_path_to_trash(action: &str, path: &Path) -> Result<(), InstallError> {
    let home = dirs::home_dir()
        .ok_or_else(|| InstallError::new("HOME_DIRECTORY_UNAVAILABLE", "无法获取当前用户主目录"))?;
    let trash_root = home.join(".Trash");
    fs::create_dir_all(&trash_root).map_err(|error| {
        InstallError::with_details(
            "LOCAL_TRASH_FAILED",
            format!("{action}失败：无法访问用户废纸篓：{error}"),
            serde_json::json!({ "path": path, "trashPath": trash_root }),
        )
    })?;
    let file_name = path.file_name().ok_or_else(|| {
        InstallError::with_details(
            "LOCAL_TRASH_FAILED",
            format!("{action}失败：目标名称无效"),
            serde_json::json!({ "path": path }),
        )
    })?;
    let mut destination = trash_root.join(file_name);
    let destination_exists = match fs::symlink_metadata(&destination) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(InstallError::with_details(
                "LOCAL_TRASH_FAILED",
                format!("{action}失败：无法检查废纸篓中的同名项目：{error}"),
                serde_json::json!({ "path": path, "trashPath": destination }),
            ));
        }
    };
    if destination_exists {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let base_name = file_name.to_string_lossy();
        destination = (0_u16..1_000)
            .map(|attempt| {
                trash_root.join(format!(
                    "{base_name}-{timestamp}-{}-{attempt}",
                    std::process::id()
                ))
            })
            .find(|candidate| {
                matches!(
                    fs::symlink_metadata(candidate),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound
                )
            })
            .ok_or_else(|| {
                InstallError::with_details(
                    "LOCAL_TRASH_FAILED",
                    format!("{action}失败：废纸篓中无法生成不重复的名称"),
                    serde_json::json!({ "path": path, "trashPath": trash_root }),
                )
            })?;
    }
    fs::rename(path, &destination).map_err(|error| {
        InstallError::with_details(
            "LOCAL_TRASH_FAILED",
            format!("{action}失败：无法移动到用户废纸篓：{error}"),
            serde_json::json!({ "path": path, "trashPath": destination }),
        )
    })
}

#[cfg(not(target_os = "macos"))]
fn move_local_skill_path_to_trash(action: &str, path: &Path) -> Result<(), InstallError> {
    trash::delete(path).map_err(|error| {
        InstallError::with_details(
            "LOCAL_TRASH_FAILED",
            format!("{action}失败：{error}"),
            serde_json::json!({ "path": path }),
        )
    })
}

fn owned_install_metadata_matches(
    path: &Path,
    input: &RemoveLocalSkillInput,
) -> Result<bool, InstallError> {
    let metadata_path = path.join(INSTALL_METADATA_FILE);
    let content = match fs::read_to_string(&metadata_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(uninstall_io_error("读取 Skill 安装信息", error)),
    };
    let metadata = serde_json::from_str::<InstalledSkillMetadata>(&content).map_err(|_| {
        InstallError::with_details(
            "LOCAL_UNINSTALL_OWNERSHIP_UNCLEAR",
            "本地 Skill 的安装信息无效，未执行删除",
            serde_json::json!({ "path": path }),
        )
    })?;
    if metadata.schema_version != 1
        || metadata.skill_id != input.skill_id
        || metadata.skill_name != input.skill_name
    {
        return Err(InstallError::with_details(
            "LOCAL_UNINSTALL_OWNERSHIP_MISMATCH",
            "本地目录不属于当前平台 Skill，未执行删除",
            serde_json::json!({ "path": path }),
        ));
    }
    Ok(true)
}

fn remove_local_skill_at_home(
    home: &Path,
    input: RemoveLocalSkillInput,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    if !is_valid_skill_name(&input.skill_name) {
        return Err(InstallError::new(
            "INVALID_SKILL_NAME",
            "Skill 名称只能包含小写字母、数字和单个连字符",
        ));
    }

    let source = private_skills_root(home).join(&input.skill_name);
    let mut source_owned = false;
    let mut canonical_source = None;
    match fs::symlink_metadata(&source) {
        Ok(metadata) => {
            let link_kind = managed_directory_link_kind(&source, &metadata)
                .map_err(|error| uninstall_io_error("检查 Skill 本体", error))?;
            if link_kind.is_some() || !metadata.is_dir() {
                return Err(InstallError::with_details(
                    "LOCAL_UNINSTALL_SOURCE_UNSAFE",
                    "Skill 私有仓库中的同名项不是可安全删除的实体目录",
                    serde_json::json!({ "path": source }),
                ));
            }
            if !owned_install_metadata_matches(&source, &input)? {
                return Err(InstallError::with_details(
                    "LOCAL_UNINSTALL_NOT_MANAGED",
                    "Skill 私有仓库中的 Skill 不是由平台安装，未执行删除",
                    serde_json::json!({ "path": source }),
                ));
            }
            canonical_source = Some(
                source
                    .canonicalize()
                    .map_err(|error| uninstall_io_error("定位 Skill 本体", error))?,
            );
            source_owned = true;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(uninstall_io_error("检查 Skill 本体", error)),
    }

    let mut manager_state = load_local_skill_manager_state(home)?;
    let mut removal_targets = Vec::<(PathBuf, LocalRemovalKind)>::new();
    for agent in ["claude", "codex"] {
        let target = preferred_agent_skills_root(home, agent)?.join(&input.skill_name);
        let metadata = match fs::symlink_metadata(&target) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(uninstall_io_error("检查 Agent Skill", error)),
        };
        let link_kind = managed_directory_link_kind(&target, &metadata)
            .map_err(|error| uninstall_io_error("检查 Agent Skill 连接", error))?;
        if let Some(link_kind) = link_kind {
            let current_target = target.canonicalize().map_err(|_| {
                InstallError::with_details(
                    "LOCAL_UNINSTALL_CONNECTION_UNSAFE",
                    "Agent 中存在失效或无法确认来源的同名连接，未执行删除",
                    serde_json::json!({ "path": target }),
                )
            })?;
            let points_to_current_source = canonical_source
                .as_ref()
                .is_some_and(|expected_source| &current_target == expected_source);
            if !points_to_current_source {
                return Err(InstallError::with_details(
                    "LOCAL_UNINSTALL_CONNECTION_CONFLICT",
                    "Agent 中的同名连接指向其他位置，未执行删除",
                    serde_json::json!({ "path": target }),
                ));
            }
            removal_targets.push((target, LocalRemovalKind::ManagedLink(link_kind)));
            continue;
        }
        if !metadata.is_dir() {
            return Err(InstallError::with_details(
                "LOCAL_UNINSTALL_TARGET_UNSAFE",
                "Agent 中的同名项不是可安全删除的 Skill 目录",
                serde_json::json!({ "path": target }),
            ));
        }

        let connection_key = managed_connection_key(agent, &input.skill_name);
        let managed_copy =
            manager_state
                .connections
                .get(&connection_key)
                .is_some_and(|connection| {
                    connection.mode == ManagedConnectionMode::Copy
                        && canonical_source.as_ref().is_some_and(|source_path| {
                            PathBuf::from(&connection.source_path)
                                .canonicalize()
                                .is_ok_and(|path| path == *source_path)
                                && managed_copy_points_to(&target, source_path)
                        })
                });
        if managed_copy || owned_install_metadata_matches(&target, &input)? {
            removal_targets.push((target, LocalRemovalKind::Directory));
            continue;
        }
        return Err(InstallError::with_details(
            "LOCAL_UNINSTALL_TARGET_CONFLICT",
            "Agent 中存在用户管理的同名独立 Skill，未执行删除",
            serde_json::json!({ "path": target }),
        ));
    }

    if !source_owned && removal_targets.is_empty() {
        return Err(InstallError::new(
            "LOCAL_UNINSTALL_NOT_FOUND",
            "没有找到可由平台卸载的本地 Skill",
        ));
    }

    for (target, kind) in &removal_targets {
        match kind {
            LocalRemovalKind::ManagedLink(_) => {
                move_local_skill_path_to_trash("将 Agent Skill 连接移到回收站", target)?;
            }
            LocalRemovalKind::Directory => {
                move_local_skill_path_to_trash("将 Agent Skill 目录移到回收站", target)?;
            }
        }
    }
    if source_owned {
        move_local_skill_path_to_trash("将 Skill 本体移到回收站", &source)?;
    }

    let mut state_changed = false;
    if let Some(source_path) = &canonical_source {
        state_changed |= manager_state
            .publications
            .remove(&source_path.to_string_lossy().into_owned())
            .is_some();
    }
    for agent in ["claude", "codex"] {
        if let Some(assignments) = manager_state.assignments.get_mut(agent) {
            let previous_length = assignments.len();
            assignments.retain(|skill_name| skill_name != &input.skill_name);
            state_changed |= assignments.len() != previous_length;
        }
        state_changed |= manager_state
            .connections
            .remove(&managed_connection_key(agent, &input.skill_name))
            .is_some();
    }
    state_changed |= manager_state
        .legacy_sources
        .remove(&input.skill_name)
        .is_some();
    manager_state
        .assignments
        .retain(|_, assignments| !assignments.is_empty());
    if state_changed {
        save_local_skill_manager_state(home, &manager_state)?;
    }

    scan_local_skills_from_home(home)
}

fn remove_local_skill_on_disk(
    input: RemoveLocalSkillInput,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    let home = dirs::home_dir()
        .ok_or_else(|| InstallError::new("HOME_DIRECTORY_UNAVAILABLE", "无法获取当前用户主目录"))?;
    remove_local_skill_at_home(&home, input)
}

fn local_skill_root_for_location(home: &Path, location: &str) -> Option<PathBuf> {
    match location {
        "MANAGER" => Some(private_skills_root(home)),
        "AGENTS" => Some(shared_skills_root(home)),
        "CLAUDE" => Some(home.join(".claude").join("skills")),
        "CODEX" => Some(home.join(".codex").join("skills")),
        _ => None,
    }
}

fn remove_local_skill_entries_at_home(
    home: &Path,
    input: RemoveLocalSkillEntriesInput,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    if input.record_ids.is_empty() {
        return Err(InstallError::new(
            "LOCAL_ENTRY_DELETE_EMPTY",
            "没有选择要移到回收站的本地 Skill 文件",
        ));
    }
    if input.record_ids.len() > 32 {
        return Err(InstallError::new(
            "LOCAL_ENTRY_DELETE_TOO_MANY",
            "一次移到回收站的本地 Skill 文件过多",
        ));
    }

    let records = scan_local_skills_from_home(home)?;
    let requested_ids = input.record_ids.into_iter().collect::<HashSet<_>>();
    let mut targets = records
        .iter()
        .filter(|record| requested_ids.contains(&record.id))
        .collect::<Vec<_>>();
    if targets.len() != requested_ids.len() {
        return Err(InstallError::new(
            "LOCAL_ENTRY_DELETE_STALE",
            "本地 Skill 文件已经发生变化，请重新扫描后再删除",
        ));
    }

    let selected_paths = targets
        .iter()
        .map(|record| record.install_path.as_str())
        .collect::<HashSet<_>>();
    let removed_publication_paths = targets
        .iter()
        .filter(|target| {
            !records.iter().any(|record| {
                record.resolved_path == target.resolved_path
                    && !requested_ids.contains(&record.id)
            })
        })
        .map(|record| record.resolved_path.clone())
        .collect::<HashSet<_>>();
    for target in &targets {
        let target_path = PathBuf::from(&target.install_path);
        let expected_root =
            local_skill_root_for_location(home, &target.location).ok_or_else(|| {
                InstallError::new("LOCAL_ENTRY_DELETE_LOCATION_INVALID", "本地 Skill 位置无效")
            })?;
        if target_path.parent() != Some(expected_root.as_path()) {
            return Err(InstallError::with_details(
                "LOCAL_ENTRY_DELETE_PATH_UNSAFE",
                "要移到回收站的路径不在允许的 Skill 目录中",
                serde_json::json!({ "path": target_path }),
            ));
        }
        let metadata = fs::symlink_metadata(&target_path)
            .map_err(|error| uninstall_io_error("检查本地 Skill 文件", error))?;
        let link_kind = managed_directory_link_kind(&target_path, &metadata)
            .map_err(|error| uninstall_io_error("检查本地 Skill 连接", error))?;
        if link_kind.is_none() && !metadata.is_dir() {
            return Err(InstallError::with_details(
                "LOCAL_ENTRY_DELETE_TARGET_UNSAFE",
                "要移到回收站的本地 Skill 既不是目录也不是目录连接",
                serde_json::json!({ "path": target_path }),
            ));
        }
        if link_kind.is_none() && target.entry_kind != "COPY" {
            let referenced_by_unselected_entry = records.iter().any(|record| {
                record.resolved_path == target.resolved_path
                    && record.install_path != target.install_path
                    && !selected_paths.contains(record.install_path.as_str())
            });
            if referenced_by_unselected_entry {
                return Err(InstallError::with_details(
                    "LOCAL_ENTRY_DELETE_STILL_REFERENCED",
                    "该 Skill 目录仍被其他 Agent 引用，请在“全部 Agents”中彻底删除",
                    serde_json::json!({ "path": target_path }),
                ));
            }
        }
    }

    targets.sort_by_key(|record| {
        let path = PathBuf::from(&record.install_path);
        fs::symlink_metadata(&path)
            .ok()
            .and_then(|metadata| managed_directory_link_kind(&path, &metadata).ok().flatten())
            .is_none()
    });
    let removed_codex_skill_definitions = targets
        .iter()
        .flat_map(|record| {
            if record.location == "AGENTS" && record.entry_kind == "DIRECTORY" {
                let source = PathBuf::from(&record.install_path);
                let mut paths = vec![skill_definition_path_text(&source.join("SKILL.md"))];
                if let Some(legacy_path) = potential_external_codex_definition_path(home, &source)
                {
                    paths.push(legacy_path);
                }
                paths
            } else if record.location == "CODEX"
                && matches!(record.entry_kind.as_str(), "SYMLINK" | "JUNCTION")
            {
                vec![skill_definition_path_text(
                    &PathBuf::from(&record.install_path).join("SKILL.md"),
                )]
            } else {
                Vec::new()
            }
        })
        .collect::<HashSet<_>>();
    for target in &targets {
        let target_path = PathBuf::from(&target.install_path);
        let metadata = fs::symlink_metadata(&target_path)
            .map_err(|error| uninstall_io_error("检查本地 Skill 文件", error))?;
        if managed_directory_link_kind(&target_path, &metadata)
            .map_err(|error| uninstall_io_error("检查本地 Skill 连接", error))?
            .is_some()
        {
            move_local_skill_path_to_trash("将本地 Skill 连接移到回收站", &target_path)?;
        } else {
            move_local_skill_path_to_trash("将本地 Skill 目录移到回收站", &target_path)?;
        }
    }
    for skill_definition in removed_codex_skill_definitions {
        if let Err(error) = remove_owned_codex_disable_for_path(home, &skill_definition) {
            warn!(
                "清理已删除 Skill 的 Codex 开关配置失败：path={}, code={}, message={}",
                skill_definition, error.code, error.message
            );
        }
    }

    let mut manager_state = load_local_skill_manager_state(home)?;
    let mut state_changed = false;
    for resolved_path in removed_publication_paths {
        state_changed |= manager_state.publications.remove(&resolved_path).is_some();
    }
    for target in &targets {
        let affected_agents: &[&str] = match target.location.as_str() {
            "CLAUDE" => &["claude"],
            "CODEX" => &["codex"],
            _ => &["claude", "codex"],
        };
        for agent in affected_agents {
            if let Some(assignments) = manager_state.assignments.get_mut(*agent) {
                let previous_length = assignments.len();
                assignments.retain(|skill_name| skill_name != &target.skill_name);
                state_changed |= assignments.len() != previous_length;
            }
            state_changed |= manager_state
                .connections
                .remove(&managed_connection_key(agent, &target.skill_name))
                .is_some();
        }
        if matches!(target.location.as_str(), "MANAGER" | "AGENTS") {
            state_changed |= manager_state
                .legacy_sources
                .remove(&target.skill_name)
                .is_some();
        }
    }
    manager_state
        .assignments
        .retain(|_, assignments| !assignments.is_empty());
    if state_changed {
        save_local_skill_manager_state(home, &manager_state)?;
    }

    scan_local_skills_from_home(home)
}

fn remove_local_skill_entries_on_disk(
    input: RemoveLocalSkillEntriesInput,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    let home = dirs::home_dir()
        .ok_or_else(|| InstallError::new("HOME_DIRECTORY_UNAVAILABLE", "无法获取当前用户主目录"))?;
    remove_local_skill_entries_at_home(&home, input)
}

fn ignored_upload_path(relative_path: &Path) -> bool {
    let segments = relative_path
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    if segments.iter().any(|segment| {
        matches!(
            segment.as_str(),
            // Version control and operating-system metadata.
            ".git"
                | ".svn"
                | ".hg"
                | "__macosx"
                // Local runtimes and dependency directories.
                | ".venv"
                | "venv"
                | "node_modules"
                | "bower_components"
                | "jspm_packages"
                | ".pnpm-store"
                | ".npm"
                // Python and test caches.
                | "__pycache__"
                | ".pytest_cache"
                | ".mypy_cache"
                | ".ruff_cache"
                | ".tox"
                | ".nox"
                | ".hypothesis"
                | ".ipynb_checkpoints"
                // Build-tool caches and reports.
                | ".cache"
                | ".parcel-cache"
                | ".vite"
                | ".turbo"
                | ".nyc_output"
                | "coverage"
                | "htmlcov"
                | "target"
                // Editor settings.
                | ".idea"
                | ".vscode"
                // Runtime output and temporary directories.
                | "output"
                | "outputs"
                | "tmp"
                | "temp"
                | "logs"
        )
    }) || segments
        .windows(2)
        .any(|pair| pair[0] == ".yarn" && matches!(pair[1].as_str(), "cache" | "unplugged"))
    {
        return true;
    }
    let file_name = segments.last().map(String::as_str).unwrap_or_default();
    matches!(
        file_name,
        ".ds_store"
            | ".localized"
            | ".appledouble"
            | ".lsoverride"
            | ".kocotree-skill.json"
            | ".kocotree-managed-copy.json"
            | "thumbs.db"
            | "desktop.ini"
            | ".coverage"
            | ".eslintcache"
            | ".stylelintcache"
    ) || file_name.starts_with("._")
        || file_name.starts_with(".coverage.")
        || file_name.ends_with(".pyc")
        || file_name.ends_with(".pyo")
        || file_name.ends_with(".pyd")
        || file_name.ends_with(".log")
        || file_name.ends_with(".tmp")
        || file_name.ends_with(".swp")
        || file_name.ends_with(".tsbuildinfo")
        || file_name.ends_with('~')
}

fn collect_upload_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(PathBuf, PathBuf)>,
    total_size: &mut u64,
) -> Result<(), InstallError> {
    let entries =
        fs::read_dir(directory).map_err(|error| io_error("读取本地 Skill 目录", error))?;
    for entry in entries {
        let entry = entry.map_err(|error| io_error("读取本地 Skill 文件", error))?;
        let path = entry.path();
        let relative_path = path.strip_prefix(root).map_err(|_| {
            InstallError::new(
                "LOCAL_SKILL_PACKAGE_FAILED",
                "本地 Skill 中包含无法解析的文件路径",
            )
        })?;
        if ignored_upload_path(relative_path) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| io_error("读取本地 Skill 文件信息", error))?;
        if metadata.file_type().is_symlink() {
            return Err(InstallError::with_details(
                "INVALID_SKILL_PACKAGE",
                "本地 Skill 中不能包含符号链接",
                serde_json::json!({
                    "path": relative_path.to_string_lossy(),
                }),
            ));
        }
        if metadata.is_dir() {
            collect_upload_files(root, &path, files, total_size)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        if files.len() >= MAX_FILE_COUNT {
            return Err(InstallError::new(
                "PACKAGE_TOO_LARGE",
                format!("Skill 文件数量不能超过 {MAX_FILE_COUNT} 个"),
            ));
        }
        *total_size = total_size.saturating_add(metadata.len());
        if *total_size > MAX_UNCOMPRESSED_SIZE {
            return Err(InstallError::new(
                "PACKAGE_TOO_LARGE",
                "Skill 文件总大小不能超过 200 MB",
            ));
        }
        files.push((relative_path.to_path_buf(), path));
    }
    Ok(())
}

fn package_local_skill_on_disk(source_path: String) -> Result<Vec<u8>, InstallError> {
    let root = PathBuf::from(source_path)
        .canonicalize()
        .map_err(|error| io_error("定位本地 Skill 本体", error))?;
    if !root.is_dir() || !root.join("SKILL.md").is_file() {
        return Err(InstallError::new(
            "INVALID_SKILL_PACKAGE",
            "选择的本地目录不是有效 Skill",
        ));
    }

    let mut files = Vec::new();
    let mut total_size = 0_u64;
    collect_upload_files(&root, &root, &mut files, &mut total_size)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));

    let cursor = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut content_entries = Vec::new();
    let mut content_folders = HashSet::new();
    for (relative_path, path) in files {
        let archive_path = relative_path
            .components()
            .map(|component| {
                component.as_os_str().to_str().ok_or_else(|| {
                    InstallError::new(
                        "INVALID_SKILL_PACKAGE",
                        "本地 Skill 文件路径必须使用有效的 Unicode 字符",
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?
            .join("/");
        writer.start_file(&archive_path, options).map_err(|error| {
            InstallError::new(
                "LOCAL_SKILL_PACKAGE_FAILED",
                format!("创建 Skill ZIP 失败：{error}"),
            )
        })?;
        let mut source =
            File::open(&path).map_err(|error| io_error("读取本地 Skill 文件", error))?;
        let mut file_digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut file_size = 0_u64;
        loop {
            let bytes_read = source
                .read(&mut buffer)
                .map_err(|error| io_error("读取本地 Skill 文件", error))?;
            if bytes_read == 0 {
                break;
            }
            file_size = file_size.saturating_add(bytes_read as u64);
            file_digest.update(&buffer[..bytes_read]);
            writer
                .write_all(&buffer[..bytes_read])
                .map_err(|error| io_error("写入 Skill ZIP", error))?;
        }
        let file_hash = file_digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path_segments = archive_path.split('/').collect::<Vec<_>>();
        for index in 1..path_segments.len() {
            content_folders.insert(path_segments[..index].join("/"));
        }
        content_entries.push(format!(
            "FILE:{archive_path}:{file_hash}:{file_size}"
        ));
    }
    content_entries.extend(
        content_folders
            .into_iter()
            .map(|folder| format!("FOLDER:{folder}::0")),
    );
    content_entries.sort();
    let canonical_content = content_entries.join("\n");
    writer.set_comment(format!(
        "kocotree-content-hash:sha256:{}",
        sha256_hex(canonical_content.as_bytes())
    ));
    let bytes = writer
        .finish()
        .map_err(|error| {
            InstallError::new(
                "LOCAL_SKILL_PACKAGE_FAILED",
                format!("完成 Skill ZIP 失败：{error}"),
            )
        })?
        .into_inner();
    if bytes.len() > MAX_PACKAGE_SIZE {
        return Err(InstallError::new(
            "PACKAGE_TOO_LARGE",
            "压缩后的 Skill ZIP 不能超过 50 MB",
        ));
    }
    Ok(bytes)
}

fn record_local_skill_publication_on_disk(
    input: RecordLocalSkillPublicationInput,
) -> Result<(), InstallError> {
    let source = PathBuf::from(&input.source_path)
        .canonicalize()
        .map_err(|error| io_error("定位本地 Skill 本体", error))?;
    if !source.is_dir() {
        return Err(InstallError::new(
            "LOCAL_SKILL_METADATA_WRITE_FAILED",
            "本地 Skill 本体目录不存在",
        ));
    }
    let skill_md = fs::read_to_string(source.join("SKILL.md"))
        .map_err(|error| io_error("读取本地 SKILL.md", error))?;
    if parse_skill_name(&skill_md)? != input.skill_name {
        return Err(InstallError::new(
            "SKILL_NAME_MISMATCH",
            "本地 Skill 名称与已发布的云端 Skill 不一致",
        ));
    }
    let metadata = InstalledSkillMetadata {
        schema_version: 1,
        skill_id: input.skill_id,
        version_id: input.version_id,
        version: input.version,
        skill_name: input.skill_name,
        display_name: input.display_name,
        display_description: input.display_description,
        content_hash: input.content_hash,
        installed_at: input.synced_at,
        origin: Some("PUBLISHED".to_string()),
    };
    let bytes = serde_json::to_vec_pretty(&metadata).map_err(|error| {
        InstallError::new(
            "LOCAL_SKILL_METADATA_WRITE_FAILED",
            format!("生成 Skill 云端关联失败：{error}"),
        )
    })?;
    let home = dirs::home_dir()
        .ok_or_else(|| InstallError::new("HOME_DIRECTORY_UNAVAILABLE", "无法获取当前用户主目录"))?;
    let source_is_manager_owned = private_skills_root(&home)
        .canonicalize()
        .ok()
        .is_some_and(|root| source.parent() == Some(root.as_path()));
    if source_is_manager_owned {
        return fs::write(source.join(INSTALL_METADATA_FILE), bytes)
            .map_err(|error| io_error("保存 Skill 云端关联", error));
    }

    let publication_key = source.to_string_lossy().into_owned();
    let mut manager_state = load_local_skill_manager_state(&home)?;
    manager_state.publications.insert(publication_key, metadata);
    save_local_skill_manager_state(&home, &manager_state)
}

fn clear_local_skill_publication_at_home(
    home: &Path,
    skill_id: &str,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    if skill_id.trim().is_empty() {
        return Err(InstallError::new(
            "LOCAL_SKILL_METADATA_CLEAR_FAILED",
            "要清除的云端 Skill 编号不能为空",
        ));
    }

    let private_root = private_skills_root(home);
    match fs::read_dir(&private_root) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|error| io_error("读取 Skill 管理器仓库", error))?;
                let metadata_path = entry.path().join(INSTALL_METADATA_FILE);
                if !metadata_path.is_file() {
                    continue;
                }
                let content = match fs::read_to_string(&metadata_path) {
                    Ok(content) => content,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(io_error("读取本地 Skill 云端关联", error)),
                };
                let Ok(metadata) = serde_json::from_str::<InstalledSkillMetadata>(&content) else {
                    continue;
                };
                if metadata.schema_version == 1 && metadata.skill_id == skill_id {
                    fs::remove_file(&metadata_path)
                        .map_err(|error| io_error("清除本地 Skill 云端关联", error))?;
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error("读取 Skill 管理器仓库", error)),
    }

    let mut manager_state = load_local_skill_manager_state(home)?;
    let previous_publication_count = manager_state.publications.len();
    manager_state
        .publications
        .retain(|_, metadata| metadata.skill_id != skill_id);
    if manager_state.publications.len() != previous_publication_count {
        save_local_skill_manager_state(home, &manager_state)?;
    }

    scan_local_skills_from_home(home)
}

fn sync_local_skill_metadata_at_home(
    home: &Path,
    input: &SyncLocalSkillMetadataInput,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    if input.skill_id.trim().is_empty()
        || input.display_name.trim().is_empty()
        || input.display_description.trim().is_empty()
    {
        return Err(InstallError::new(
            "LOCAL_SKILL_METADATA_SYNC_FAILED",
            "云端 Skill 编号、展示名称和展示简介不能为空",
        ));
    }

    let private_root = private_skills_root(home);
    match fs::read_dir(&private_root) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|error| io_error("读取 Skill 管理器仓库", error))?;
                let metadata_path = entry.path().join(INSTALL_METADATA_FILE);
                if !metadata_path.is_file() {
                    continue;
                }
                let content = match fs::read_to_string(&metadata_path) {
                    Ok(content) => content,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(io_error("读取本地 Skill 云端关联", error)),
                };
                let Ok(mut metadata) = serde_json::from_str::<InstalledSkillMetadata>(&content)
                else {
                    continue;
                };
                if metadata.schema_version != 1
                    || metadata.skill_id != input.skill_id
                {
                    continue;
                }
                if metadata.display_name == input.display_name
                    && metadata.display_description == input.display_description
                {
                    continue;
                }
                metadata.display_name = input.display_name.clone();
                metadata.display_description = input.display_description.clone();
                let bytes = serde_json::to_vec_pretty(&metadata).map_err(|error| {
                    InstallError::new(
                        "LOCAL_SKILL_METADATA_SYNC_FAILED",
                        format!("生成本地 Skill 云端关联失败：{error}"),
                    )
                })?;
                fs::write(&metadata_path, bytes)
                    .map_err(|error| io_error("同步本地 Skill 展示信息", error))?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error("读取 Skill 管理器仓库", error)),
    }

    let mut manager_state = load_local_skill_manager_state(home)?;
    let mut state_changed = false;
    for metadata in manager_state.publications.values_mut() {
        if metadata.schema_version == 1
            && metadata.skill_id == input.skill_id
        {
            if metadata.display_name != input.display_name
                || metadata.display_description != input.display_description
            {
                metadata.display_name = input.display_name.clone();
                metadata.display_description = input.display_description.clone();
                state_changed = true;
            }
        }
    }
    if state_changed {
        save_local_skill_manager_state(home, &manager_state)?;
    }

    scan_local_skills_from_home(home)
}

fn sync_local_skill_metadata_on_disk(
    input: SyncLocalSkillMetadataInput,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    let home = dirs::home_dir()
        .ok_or_else(|| InstallError::new("HOME_DIRECTORY_UNAVAILABLE", "无法获取当前用户主目录"))?;
    sync_local_skill_metadata_at_home(&home, &input)
}

fn clear_local_skill_publication_on_disk(
    skill_id: String,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    let home = dirs::home_dir()
        .ok_or_else(|| InstallError::new("HOME_DIRECTORY_UNAVAILABLE", "无法获取当前用户主目录"))?;
    clear_local_skill_publication_at_home(&home, &skill_id)
}

/** 将指定本地 Skill 本体目录打包，并通过二进制 IPC 返回 ZIP 内容。 */
#[tauri::command]
pub async fn package_local_skill(
    source_path: String,
) -> Result<tauri::ipc::Response, InstallError> {
    let bytes =
        tauri::async_runtime::spawn_blocking(move || package_local_skill_on_disk(source_path))
            .await
            .map_err(|error| {
                InstallError::new(
                    "LOCAL_SKILL_PACKAGE_FAILED",
                    format!("打包本地 Skill 失败：{error}"),
                )
            })??;
    Ok(tauri::ipc::Response::new(bytes))
}

/** 发布成功后记录本地 Skill 对应的云端版本。 */
#[tauri::command]
pub async fn record_local_skill_publication(
    input: RecordLocalSkillPublicationInput,
) -> Result<(), InstallError> {
    tauri::async_runtime::spawn_blocking(move || record_local_skill_publication_on_disk(input))
        .await
        .map_err(|error| {
            InstallError::new(
                "LOCAL_SKILL_METADATA_WRITE_FAILED",
                format!("保存 Skill 云端关联失败：{error}"),
            )
        })?
}

/** 云端展示信息变更后更新本机保存的关联元数据，并返回最新扫描结果。 */
#[tauri::command]
pub async fn sync_local_skill_metadata(
    input: SyncLocalSkillMetadataInput,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    tauri::async_runtime::spawn_blocking(move || sync_local_skill_metadata_on_disk(input))
        .await
        .map_err(|error| {
            InstallError::new(
                "LOCAL_SKILL_METADATA_SYNC_FAILED",
                format!("同步本地 Skill 展示信息失败：{error}"),
            )
        })?
}

/** 云端 Skill 永久删除后解除本机发布关联，不删除 Skill 本体。 */
#[tauri::command]
pub async fn clear_local_skill_publication(
    skill_id: String,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    tauri::async_runtime::spawn_blocking(move || clear_local_skill_publication_on_disk(skill_id))
        .await
        .map_err(|error| {
            InstallError::new(
                "LOCAL_SKILL_METADATA_CLEAR_FAILED",
                format!("清除本地 Skill 云端关联失败：{error}"),
            )
        })?
}

/** 迁移旧版共享本体，并扫描私有仓库以及 Claude Code/Codex 生效目录。 */
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

/** 通过创建或移除 Agent 专属目录连接，开启或彻底关闭指定 Agent 的 Skill。 */
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

/** 安全移除平台安装的 Skill 本体及其 Claude Code/Codex 受管连接。 */
#[tauri::command]
pub async fn remove_local_skill(
    input: RemoveLocalSkillInput,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    info!(
        "开始卸载 Skill：skill_id={}, skill_name={}",
        input.skill_id, input.skill_name
    );
    let skill_name = input.skill_name.clone();
    let result = tauri::async_runtime::spawn_blocking(move || remove_local_skill_on_disk(input))
        .await
        .map_err(|error| {
            InstallError::new(
                "LOCAL_UNINSTALL_FAILED",
                format!("卸载本地 Skill 失败：{error}"),
            )
        })?;
    match &result {
        Ok(_) => info!("Skill 卸载完成：skill_name={skill_name}"),
        Err(uninstall_error) => error!(
            "Skill 卸载失败：skill_name={}, code={}, message={}",
            skill_name, uninstall_error.code, uninstall_error.message
        ),
    }
    result
}

/** 将用户明确选择的扫描条目移到系统回收站；连接不会影响其源目录。 */
#[tauri::command]
pub async fn remove_local_skill_entries(
    input: RemoveLocalSkillEntriesInput,
) -> Result<Vec<LocalSkillRecord>, InstallError> {
    info!(
        "开始将本地 Skill 条目移到回收站：record_count={}",
        input.record_ids.len()
    );
    tauri::async_runtime::spawn_blocking(move || remove_local_skill_entries_on_disk(input))
        .await
        .map_err(|error| {
            InstallError::new(
                "LOCAL_ENTRY_DELETE_FAILED",
                format!("将本地 Skill 文件移到回收站失败：{error}"),
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
            display_description: "测试安装流程".to_string(),
            content_hash: format!("sha256:{}", "1".repeat(64)),
            installed_at: "2026-01-01T00:00:00.000Z".to_string(),
            download_url: "data:application/zip;base64,".to_string(),
            package_sha256: format!("sha256:{}", sha256_hex(bytes)),
            force: false,
        }
    }

    #[test]
    fn installs_valid_package() {
        let root = tempfile::tempdir().unwrap();
        let bytes = create_package("test-skill", Some("test-skill"));
        let result = install_package_bytes(
            &input_for("test-skill", &bytes),
            &bytes,
            root.path(),
            &root.path().join("backups"),
        )
        .unwrap();

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

        let error = install_package_bytes(
            &input_for("test-skill", &bytes),
            &bytes,
            root.path(),
            &root.path().join("backups"),
        )
        .unwrap_err();

        assert_eq!(error.code, "LOCAL_SKILL_CONFLICT");
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details["forceSupported"].as_bool()),
            Some(true)
        );
        assert_eq!(
            fs::read_to_string(target.join("original.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn replaces_existing_target_after_confirmation_and_keeps_backup() {
        let root = tempfile::tempdir().unwrap();
        let backups_root = root.path().join("backups");
        let target = root.path().join("test-skill");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("original.txt"), "keep").unwrap();
        let bytes = create_package("test-skill", None);
        let mut input = input_for("test-skill", &bytes);
        input.force = true;

        let result = install_package_bytes(&input, &bytes, root.path(), &backups_root).unwrap();

        assert!(target.join("SKILL.md").is_file());
        assert!(!target.join("original.txt").exists());
        let backup_path = PathBuf::from(result.backup_path.unwrap());
        assert!(backup_path.starts_with(&backups_root));
        assert_eq!(
            fs::read_to_string(backup_path.join("original.txt")).unwrap(),
            "keep"
        );
        assert_eq!(result.replaced_skill_name.as_deref(), Some("test-skill"));
    }

    #[test]
    fn validates_replacement_package_before_moving_existing_target() {
        let root = tempfile::tempdir().unwrap();
        let backups_root = root.path().join("backups");
        let target = root.path().join("test-skill");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("original.txt"), "keep").unwrap();
        let bytes = create_package("another-skill", None);
        let mut input = input_for("test-skill", &bytes);
        input.force = true;

        let error = install_package_bytes(&input, &bytes, root.path(), &backups_root).unwrap_err();

        assert_eq!(error.code, "SKILL_NAME_MISMATCH");
        assert_eq!(
            fs::read_to_string(target.join("original.txt")).unwrap(),
            "keep"
        );
        assert!(!backups_root.exists());
    }

    #[test]
    fn rejects_package_hash_mismatch() {
        let root = tempfile::tempdir().unwrap();
        let bytes = create_package("test-skill", None);
        let mut input = input_for("test-skill", &bytes);
        input.package_sha256 = format!("sha256:{}", "0".repeat(64));

        let error =
            install_package_bytes(&input, &bytes, root.path(), &root.path().join("backups"))
                .unwrap_err();

        assert_eq!(error.code, "PACKAGE_HASH_MISMATCH");
        assert!(!root.path().join("test-skill").exists());
    }

    #[test]
    fn rejects_skill_name_mismatch() {
        let root = tempfile::tempdir().unwrap();
        let bytes = create_package("another-skill", None);

        let error = install_package_bytes(
            &input_for("test-skill", &bytes),
            &bytes,
            root.path(),
            &root.path().join("backups"),
        )
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

        let error = install_package_bytes(
            &input_for("test-skill", &bytes),
            &bytes,
            root.path(),
            &root.path().join("backups"),
        )
        .unwrap_err();

        assert_eq!(error.code, "INVALID_SKILL_PACKAGE");
        assert!(!root.path().join("test-skill").exists());
        assert!(!root.path().parent().unwrap().join("escape.txt").exists());
    }

    #[test]
    fn uninstalls_platform_skill_and_managed_agent_connections() {
        let home = tempfile::tempdir().unwrap();
        let claude_command = home.path().join(".local").join("bin").join("claude");
        fs::create_dir_all(claude_command.parent().unwrap()).unwrap();
        fs::write(claude_command, "").unwrap();
        let bytes = create_package("test-skill", None);
        let skills_root = private_skills_root(home.path());
        install_package_bytes(
            &input_for("test-skill", &bytes),
            &bytes,
            &skills_root,
            &private_backups_root(home.path()),
        )
        .unwrap();
        let source = skills_root.join("test-skill");

        for agent in ["claude", "codex"] {
            set_local_skill_enabled_at_home(
                home.path(),
                SetLocalSkillEnabledInput {
                    skill_name: "test-skill".to_string(),
                    source_path: source.to_string_lossy().into_owned(),
                    agent: agent.to_string(),
                    enabled: true,
                },
            )
            .unwrap();
        }

        let records = remove_local_skill_at_home(
            home.path(),
            RemoveLocalSkillInput {
                skill_id: "skill-test".to_string(),
                skill_name: "test-skill".to_string(),
            },
        )
        .unwrap();

        assert!(!source.exists());
        assert!(!home
            .path()
            .join(".claude")
            .join("skills")
            .join("test-skill")
            .exists());
        assert!(!home
            .path()
            .join(".codex")
            .join("skills")
            .join("test-skill")
            .exists());
        assert!(!records
            .iter()
            .any(|record| record.skill_name == "test-skill"));
        let state = load_local_skill_manager_state(home.path()).unwrap();
        assert!(state
            .assignments
            .values()
            .all(|skills| { !skills.iter().any(|skill_name| skill_name == "test-skill") }));
        assert!(state.connections.is_empty());
    }

    #[test]
    fn uninstall_stops_before_deleting_an_independent_agent_directory() {
        let home = tempfile::tempdir().unwrap();
        let bytes = create_package("test-skill", None);
        let skills_root = private_skills_root(home.path());
        install_package_bytes(
            &input_for("test-skill", &bytes),
            &bytes,
            &skills_root,
            &private_backups_root(home.path()),
        )
        .unwrap();
        let source = skills_root.join("test-skill");
        let independent = home.path().join(".codex").join("skills").join("test-skill");
        fs::create_dir_all(&independent).unwrap();
        fs::write(
            independent.join("SKILL.md"),
            "---\nname: test-skill\ndescription: independent\n---\n",
        )
        .unwrap();
        fs::write(independent.join("keep.txt"), "keep").unwrap();

        let error = remove_local_skill_at_home(
            home.path(),
            RemoveLocalSkillInput {
                skill_id: "skill-test".to_string(),
                skill_name: "test-skill".to_string(),
            },
        )
        .unwrap_err();

        assert_eq!(error.code, "LOCAL_UNINSTALL_TARGET_CONFLICT");
        assert!(source.join("SKILL.md").is_file());
        assert_eq!(
            fs::read_to_string(independent.join("keep.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn enabling_still_refuses_a_link_to_an_unknown_location() {
        let home = tempfile::tempdir().unwrap();
        let source = private_skills_root(home.path()).join("test-skill");
        let unknown_source = home.path().join("other").join("test-skill");
        let codex_link = home.path().join(".codex").join("skills").join("test-skill");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&unknown_source).unwrap();
        for path in [&source, &unknown_source] {
            fs::write(
                path.join("SKILL.md"),
                "---\nname: test-skill\ndescription: test\n---\n",
            )
            .unwrap();
        }
        fs::create_dir_all(codex_link.parent().unwrap()).unwrap();
        create_managed_directory_link(&unknown_source, &codex_link).unwrap();

        let error = set_local_skill_enabled_at_home(
            home.path(),
            SetLocalSkillEnabledInput {
                skill_name: "test-skill".to_string(),
                source_path: source.to_string_lossy().into_owned(),
                agent: "codex".to_string(),
                enabled: true,
            },
        )
        .unwrap_err();

        assert_eq!(error.code, "LOCAL_SKILL_TARGET_CONFLICT");
        assert_eq!(
            codex_link.canonicalize().unwrap(),
            unknown_source.canonicalize().unwrap()
        );
    }

    #[test]
    fn uninstall_refuses_an_unmanaged_private_skill() {
        let home = tempfile::tempdir().unwrap();
        let source = private_skills_root(home.path()).join("test-skill");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: test-skill\ndescription: unmanaged\n---\n",
        )
        .unwrap();

        let error = remove_local_skill_at_home(
            home.path(),
            RemoveLocalSkillInput {
                skill_id: "skill-test".to_string(),
                skill_name: "test-skill".to_string(),
            },
        )
        .unwrap_err();

        assert_eq!(error.code, "LOCAL_UNINSTALL_NOT_MANAGED");
        assert!(source.join("SKILL.md").is_file());
    }

    #[test]
    fn codex_toggle_only_changes_the_managed_connection() {
        let home = tempfile::tempdir().unwrap();
        let source = private_skills_root(home.path()).join("test-skill");
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
        let source = private_skills_root(home.path()).join("test-skill");
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
    fn copies_legacy_manager_state_without_removing_the_old_file() {
        let home = tempfile::tempdir().unwrap();
        let legacy_state_path = legacy_local_skill_manager_state_path(home.path());
        fs::create_dir_all(legacy_state_path.parent().unwrap()).unwrap();
        fs::write(
            &legacy_state_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "assignments": {
                    "codex": ["test-skill"]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        let state = load_local_skill_manager_state(home.path()).unwrap();

        assert_eq!(
            state.assignments.get("codex"),
            Some(&vec!["test-skill".to_string()])
        );
        assert!(legacy_state_path.is_file());
        assert!(local_skill_manager_state_path(home.path()).is_file());
    }

    #[test]
    fn scanning_refreshes_a_managed_copy_when_the_source_changes() {
        let home = tempfile::tempdir().unwrap();
        let source = private_skills_root(home.path()).join("test-skill");
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
        let source = private_skills_root(home.path()).join("test-skill");
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
