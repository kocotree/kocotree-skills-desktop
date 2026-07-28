use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CALLBACK_EVENT: &str = "desktop-auth-callback";
const MAX_REQUEST_LINE_BYTES: u64 = 8 * 1024;
const SUCCESS_PAGE: &str = "<!doctype html><meta charset=\"utf-8\"><title>登录成功</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:grid;place-items:center;min-height:80vh;color:#173f2c}main{text-align:center}</style><main><h1>飞书授权成功</h1><p>已经返回 Kocotree Skills，可以关闭此页面。</p></main>";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthCallback {
    callback_url: String,
}

pub fn focus_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("无法激活主窗口：窗口不存在");
        return;
    };

    if let Err(error) = window.show() {
        log::warn!("显示主窗口失败: {error}");
    }
    if let Err(error) = window.unminimize() {
        log::warn!("取消主窗口最小化失败: {error}");
    }
    if let Err(error) = window.set_focus() {
        log::warn!("聚焦主窗口失败: {error}");
    }
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn handle_callback(mut stream: TcpStream, app: &AppHandle, callback_origin: &str) -> bool {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut request_line = String::new();
    {
        let reader = BufReader::new(&mut stream);
        let mut limited_reader = reader.take(MAX_REQUEST_LINE_BYTES + 1);
        if limited_reader.read_line(&mut request_line).is_err()
            || request_line.len() as u64 > MAX_REQUEST_LINE_BYTES
        {
            respond(
                &mut stream,
                "400 Bad Request",
                "<h1>请求无效</h1><p>请返回 Kocotree Skills 重新登录。</p>",
            );
            return false;
        }
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next();
    let target = parts.next();
    if method != Some("GET") {
        respond(&mut stream, "405 Method Not Allowed", "");
        return false;
    }

    let Some(target) = target else {
        respond(&mut stream, "400 Bad Request", "");
        return false;
    };
    if target != "/auth/callback" && !target.starts_with("/auth/callback?") {
        respond(&mut stream, "404 Not Found", "");
        return false;
    }

    let callback_url = format!("{callback_origin}{target}");
    if app.emit(CALLBACK_EVENT, callback_url).is_err() {
        respond(
            &mut stream,
            "500 Internal Server Error",
            "<h1>无法通知应用</h1><p>请返回 Kocotree Skills 重新登录。</p>",
        );
        return false;
    }

    focus_main_window(app);
    respond(&mut stream, "200 OK", SUCCESS_PAGE);
    true
}

#[tauri::command]
pub fn begin_desktop_auth_callback(app: AppHandle) -> Result<DesktopAuthCallback, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("无法启动本地登录回调：{error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("无法配置本地登录回调：{error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("无法读取本地登录回调地址：{error}"))?;
    let callback_origin = format!("http://127.0.0.1:{}", address.port());
    let callback_url = format!("{callback_origin}/auth/callback");

    thread::spawn(move || {
        let started_at = Instant::now();
        while started_at.elapsed() < CALLBACK_TIMEOUT {
            match listener.accept() {
                Ok((stream, _)) => {
                    if handle_callback(stream, &app, &callback_origin) {
                        return;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(error) => {
                    log::error!("本地登录回调监听失败: {error}");
                    return;
                }
            }
        }
        log::warn!("本地登录回调等待超时");
    });

    Ok(DesktopAuthCallback { callback_url })
}
