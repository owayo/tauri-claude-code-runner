use chrono::{Datelike, Timelike};
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, State};
use tokio::time::sleep;

struct AppState {
    is_running: Arc<Mutex<bool>>,
    cancel_flag: Arc<Mutex<bool>>,
}

#[derive(Serialize, Deserialize)]
struct ExecutionResult {
    status: String,
    #[serde(rename = "terminalOutput")]
    terminal_output: Option<String>,
    #[serde(rename = "needsRetry")]
    needs_retry: Option<bool>,
    #[serde(rename = "retryTime")]
    retry_time: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ITermStatus {
    is_installed: bool,
    is_running: bool,
}

#[tauri::command]
async fn check_iterm_status() -> Result<ITermStatus, String> {
    // First check if iTerm is installed
    let check_installed = Command::new("osascript")
        .arg("-e")
        .arg(r#"tell application "Finder" to return exists application file id "com.googlecode.iterm2""#)
        .output()
        .map_err(|e| format!("iTerm確認エラー: {}", e))?;

    let is_installed = if check_installed.status.success() {
        let result = String::from_utf8_lossy(&check_installed.stdout)
            .trim()
            .to_string();
        result == "true"
    } else {
        false
    };

    // Only check if running when installed
    let is_running = if is_installed {
        let check_running = Command::new("osascript")
            .arg("-e")
            .arg(r#"tell application "System Events" to (name of processes) contains "iTerm2""#)
            .output()
            .map_err(|e| format!("iTerm状態確認エラー: {}", e))?;

        if check_running.status.success() {
            let result = String::from_utf8_lossy(&check_running.stdout)
                .trim()
                .to_string();
            result == "true"
        } else {
            false
        }
    } else {
        false
    };

    Ok(ITermStatus {
        is_installed,
        is_running,
    })
}

#[tauri::command]
async fn execute_claude_command(
    execution_time: String, // HH:MM format
    target_directory: String,
    claude_options: String,
    claude_command: String,
    auto_retry_on_rate_limit: bool,
    use_new_window: bool,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ExecutionResult, String> {
    let is_running_clone = state.is_running.clone();
    let cancel_flag_clone = state.cancel_flag.clone();

    {
        let mut is_running = is_running_clone.lock().unwrap();
        if *is_running {
            return Err("コマンドは既に実行中です".to_string());
        }
        *is_running = true;

        let mut cancel_flag = cancel_flag_clone.lock().unwrap();
        *cancel_flag = false;
    }

    // Check if target directory exists
    if !std::path::Path::new(&target_directory).exists() {
        let mut is_running = is_running_clone.lock().unwrap();
        *is_running = false;
        return Err(format!("ディレクトリが存在しません: {}", target_directory));
    }

    // Parse execution time
    let parts: Vec<&str> = execution_time.split(':').collect();
    if parts.len() != 2 {
        let mut is_running = is_running_clone.lock().unwrap();
        *is_running = false;
        return Err("時刻の形式が正しくありません".to_string());
    }

    let hour: u32 = match parts[0].parse() {
        Ok(h) => h,
        Err(_) => {
            let mut is_running = is_running_clone.lock().unwrap();
            *is_running = false;
            return Err("時間の解析エラー".to_string());
        }
    };

    let minute: u32 = match parts[1].parse() {
        Ok(m) => m,
        Err(_) => {
            let mut is_running = is_running_clone.lock().unwrap();
            *is_running = false;
            return Err("分の解析エラー".to_string());
        }
    };

    // Calculate wait time
    let now = chrono::Local::now();
    let mut target = match chrono::Local::now()
        .with_hour(hour)
        .and_then(|t| t.with_minute(minute))
        .and_then(|t| t.with_second(0))
    {
        Some(t) => t,
        None => {
            let mut is_running = is_running_clone.lock().unwrap();
            *is_running = false;
            return Err("時刻の設定エラー".to_string());
        }
    };

    // If target time is in the past, move to tomorrow
    if target <= now {
        target = target + chrono::Duration::days(1);
    }

    let wait_duration = target.signed_duration_since(now);
    let wait_millis = wait_duration.num_milliseconds() as u64;

    // Wait until target time with cancellation check
    let check_interval = Duration::from_secs(1);
    let mut elapsed = Duration::from_millis(0);
    let total_wait = Duration::from_millis(wait_millis);

    while elapsed < total_wait {
        // Check cancel flag
        {
            let cancel = cancel_flag_clone.lock().unwrap();
            if *cancel {
                let mut is_running = is_running_clone.lock().unwrap();
                *is_running = false;
                return Err("実行がキャンセルされました".to_string());
            }
        }

        sleep(check_interval).await;
        elapsed += check_interval;
    }

    // Send event to frontend that execution is starting
    app.emit("execution-started", "").ok();

    // Execute AppleScript
    let result = execute_applescript(
        &target_directory,
        &claude_options,
        &claude_command,
        auto_retry_on_rate_limit,
        use_new_window,
        &app,
        &state,
    )
    .await;

    let mut is_running = is_running_clone.lock().unwrap();
    *is_running = false;

    result
}

async fn execute_applescript(
    target_directory: &str,
    claude_options: &str,
    claude_command: &str,
    auto_retry_on_rate_limit: bool,
    use_new_window: bool,
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
) -> Result<ExecutionResult, String> {
    execute_applescript_internal(
        target_directory,
        claude_options,
        claude_command,
        use_new_window,
    )
    .await?;

    if auto_retry_on_rate_limit {
        let start_time = std::time::Instant::now();
        let mut had_esc_to_interrupt = false;
        let mut esc_absent_count = 0;
        let mut first_esc_absent_time: Option<std::time::Instant> = None;
        let mut reset_at_count = 0;

        // Check every minute for rate limit messages and completion
        loop {
            // Check if cancelled
            {
                let cancel_flag = state.cancel_flag.lock().unwrap();
                if *cancel_flag {
                    return Ok(ExecutionResult {
                        status: "cancelled".to_string(),
                        terminal_output: None,
                        needs_retry: Some(false),
                        retry_time: None,
                    });
                }
            }

            sleep(Duration::from_secs(60)).await;

            let output = get_terminal_output("iTerm").await?;
            app.emit("terminal-output", &output).ok();

            // Check if "esc to interrupt" exists
            let has_esc_to_interrupt = output.contains("esc to interrupt");
            let has_reset_at = output.contains("reset at");

            // If "esc to interrupt" was present before but is now gone, increment absent count
            if had_esc_to_interrupt && !has_esc_to_interrupt {
                esc_absent_count += 1;
                println!("'esc to interrupt' not found (count: {})", esc_absent_count);

                // Record the first time we detected absence (subtract 60 seconds since we check every minute)
                if esc_absent_count == 1 {
                    first_esc_absent_time =
                        Some(std::time::Instant::now() - Duration::from_secs(60));
                }

                // If absent 3 times consecutively AND no "reset at" detected, processing is complete
                if esc_absent_count >= 3 && !has_reset_at {
                    // Calculate elapsed time from start to first absence detection
                    let completion_time =
                        first_esc_absent_time.unwrap_or(std::time::Instant::now());
                    let elapsed = completion_time.duration_since(start_time);
                    let minutes = elapsed.as_secs() / 60;
                    let seconds = elapsed.as_secs() % 60;

                    println!("Processing completed after {}m{}s", minutes, seconds);

                    return Ok(ExecutionResult {
                        status: format!("completed_in_{}m{}s", minutes, seconds),
                        terminal_output: Some(output),
                        needs_retry: Some(false),
                        retry_time: None,
                    });
                }
            } else if has_esc_to_interrupt {
                // Reset counter and clear first absence time if "esc to interrupt" is found again
                esc_absent_count = 0;
                first_esc_absent_time = None;
                had_esc_to_interrupt = true;
            }

            // Check for "reset at" and count consecutive occurrences
            if output.contains("reset at") {
                reset_at_count += 1;
                println!("'reset at' detected (count: {})", reset_at_count);

                // Check if we've detected 3 consecutive "reset at" messages
                if reset_at_count >= 3 {
                    // Rate limit detected - schedule re-execution at next hour:01
                    let now = chrono::Local::now();
                    let current_hour = now.hour();
                    let current_minute = now.minute();

                    // Calculate next x:01 time
                    let next_hour = if current_minute == 0 {
                        // If it's exactly X:00, schedule for X:01
                        current_hour
                    } else {
                        // Otherwise schedule for next hour's :01
                        (current_hour + 1) % 24
                    };

                    let mut next_execution = now
                        .with_hour(next_hour)
                        .ok_or("時間の設定エラー")?
                        .with_minute(1)
                        .ok_or("分の設定エラー")?
                        .with_second(0)
                        .ok_or("秒の設定エラー")?;

                    // If next_execution is in the past (shouldn't happen unless it's exactly X:01), add a day
                    if next_execution <= now {
                        next_execution = next_execution + chrono::Duration::days(1);
                    }

                    let wait_duration = next_execution.signed_duration_since(now);
                    let wait_seconds = wait_duration.num_seconds();
                    let wait_minutes = wait_seconds / 60;

                    println!(
                        "Rate limit detected (3 consecutive), scheduling re-execution at {:02}:01",
                        if next_execution.day() != now.day() {
                            (next_hour + 24) % 24
                        } else {
                            next_hour
                        }
                    );

                    // Notify frontend about the scheduled re-execution
                    app.emit(
                        "terminal-output",
                        &format!(
                            "Rate limit detected (3回連続). 次の実行時刻: {:02}:01 (残り約{}分)",
                            if next_execution.day() != now.day() {
                                (next_hour + 24) % 24
                            } else {
                                next_hour
                            },
                            wait_minutes
                        ),
                    )
                    .ok();
                    app.emit(
                        "rate-limit-retry-scheduled",
                        format!(
                            "{:02}:01",
                            if next_execution.day() != now.day() {
                                (next_hour + 24) % 24
                            } else {
                                next_hour
                            }
                        ),
                    )
                    .ok();

                    // Wait until the scheduled time
                    let mut waited = Duration::from_secs(0);
                    let total_wait = Duration::from_secs(wait_seconds as u64);

                    while waited < total_wait {
                        {
                            let cancel_flag = state.cancel_flag.lock().unwrap();
                            if *cancel_flag {
                                return Ok(ExecutionResult {
                                    status: "cancelled".to_string(),
                                    terminal_output: None,
                                    needs_retry: Some(false),
                                    retry_time: None,
                                });
                            }
                        }

                        // 60秒ごとに状態更新
                        sleep(Duration::from_secs(60)).await;
                        waited += Duration::from_secs(60);

                        // 現在の状態を通知
                        let remaining_seconds = total_wait.as_secs() - waited.as_secs();
                        let remaining_minutes = remaining_seconds / 60;
                        let status_update = format!(
                            "Rate limit detected. 次の実行を待機中 (残り約{}分)",
                            remaining_minutes
                        );
                        app.emit("terminal-output", &status_update).ok();
                    }

                    // Send "continue" to terminal
                    send_continue_to_terminal("iTerm").await?;

                    // Reset the counter after sending continue
                    reset_at_count = 0;
                }
            } else {
                // Reset counter if "reset at" is not found
                if reset_at_count > 0 {
                    println!(
                        "'reset at' not found, resetting counter from {}",
                        reset_at_count
                    );
                }
                reset_at_count = 0;
            }
        }
    } else {
        // When auto-retry is disabled, just monitor for rate limit and terminate
        let start_time = std::time::Instant::now();
        let mut had_esc_to_interrupt = false;
        let mut esc_absent_count = 0;
        let mut first_esc_absent_time: Option<std::time::Instant> = None;
        let mut reset_at_count = 0;

        loop {
            // Check if cancelled
            {
                let cancel_flag = state.cancel_flag.lock().unwrap();
                if *cancel_flag {
                    return Ok(ExecutionResult {
                        status: "cancelled".to_string(),
                        terminal_output: None,
                        needs_retry: Some(false),
                        retry_time: None,
                    });
                }
            }

            sleep(Duration::from_secs(60)).await;

            let output = get_terminal_output("iTerm").await?;
            app.emit("terminal-output", &output).ok();

            // Check if "esc to interrupt" exists
            let has_esc_to_interrupt = output.contains("esc to interrupt");
            let has_reset_at = output.contains("reset at");

            // If "esc to interrupt" was present before but is now gone, increment absent count
            if had_esc_to_interrupt && !has_esc_to_interrupt {
                esc_absent_count += 1;
                println!("'esc to interrupt' not found (count: {})", esc_absent_count);

                // Record the first time we detected absence (subtract 60 seconds since we check every minute)
                if esc_absent_count == 1 {
                    first_esc_absent_time =
                        Some(std::time::Instant::now() - Duration::from_secs(60));
                }

                // If absent 3 times consecutively AND no "reset at" detected, processing is complete
                if esc_absent_count >= 3 && !has_reset_at {
                    // Calculate elapsed time from start to first absence detection
                    let completion_time =
                        first_esc_absent_time.unwrap_or(std::time::Instant::now());
                    let elapsed = completion_time.duration_since(start_time);
                    let minutes = elapsed.as_secs() / 60;
                    let seconds = elapsed.as_secs() % 60;

                    println!("Processing completed after {}m{}s", minutes, seconds);

                    return Ok(ExecutionResult {
                        status: format!("completed_in_{}m{}s", minutes, seconds),
                        terminal_output: Some(output),
                        needs_retry: Some(false),
                        retry_time: None,
                    });
                }
            } else if has_esc_to_interrupt {
                // Reset counter and clear first absence time if "esc to interrupt" is found again
                esc_absent_count = 0;
                first_esc_absent_time = None;
                had_esc_to_interrupt = true;
            }

            // Check for "reset at" and count consecutive occurrences
            if output.contains("reset at") {
                reset_at_count += 1;
                println!("'reset at' detected (count: {})", reset_at_count);

                // Check if we've detected 3 consecutive "reset at" messages
                if reset_at_count >= 3 {
                    println!("Rate limit detected (3 consecutive), terminating as auto-retry is disabled");
                    app.emit(
                        "terminal-output",
                        "Rate limit detected (3回連続). 自動再実行は無効のため終了します。",
                    )
                    .ok();

                    return Ok(ExecutionResult {
                        status: "rate_limit_detected".to_string(),
                        terminal_output: Some(output),
                        needs_retry: Some(false),
                        retry_time: None,
                    });
                }
            } else {
                // Reset counter if "reset at" is not found
                if reset_at_count > 0 {
                    println!(
                        "'reset at' not found, resetting counter from {}",
                        reset_at_count
                    );
                }
                reset_at_count = 0;
            }
        }
    }
}

async fn execute_applescript_internal(
    target_directory: &str,
    claude_options: &str,
    claude_command: &str,
    use_new_window: bool,
) -> Result<String, String> {
    let applescript = if use_new_window {
        // Create new window
        format!(
            r#"
property targetDirectory : "{}"
property claudeOptions : "{}"
property claudeCommand : "{}"

tell application "iTerm"
    activate

    -- 新規ウィンドウを作成
    create window with default profile

    tell current session of current window
        -- ディレクトリに移動
        write text "cd " & targetDirectory

        -- Claude Code を実行
        write text "claude --dangerously-skip-permissions " & claudeOptions & " \"" & claudeCommand & "\""
    end tell
end tell
            "#,
            target_directory, claude_options, claude_command
        )
    } else {
        // Use existing window - send command only
        format!(
            r#"
property claudeCommand : "{}"

tell application "iTerm"
    activate

    -- 現在のウィンドウの現在のセッションに命令を送信
    if (count of windows) > 0 then
        tell current window
            tell current session
                -- 命令のみを送信（Claude Codeが既に実行されていることを前提）
                write text claudeCommand
                -- Enterキーを送信
                write text ""
            end tell
        end tell
    else
        error "iTermウィンドウが開いていません"
    end if
end tell
            "#,
            claude_command
        )
    };

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&applescript)
        .output();

    match output {
        Ok(output) => {
            if output.status.success() {
                Ok("AppleScript実行完了".to_string())
            } else {
                Err(format!(
                    "AppleScriptエラー: {}",
                    String::from_utf8_lossy(&output.stderr)
                ))
            }
        }
        Err(e) => Err(format!("実行エラー: {}", e)),
    }
}

async fn get_terminal_output(_terminal_app: &str) -> Result<String, String> {
    // Get the last 20 lines of terminal output from iTerm
    let applescript = r#"
tell application "iTerm"
    tell current window
        tell current session
            set outputText to contents
            set outputLines to paragraphs of outputText

            -- Get last 20 lines
            set lineCount to count of outputLines
            if lineCount > 20 then
                set startIndex to lineCount - 19
            else
                set startIndex to 1
            end if

            set lastLines to ""
            repeat with i from startIndex to lineCount
                if i > startIndex then
                    set lastLines to lastLines & "\n"
                end if
                set lastLines to lastLines & item i of outputLines
            end repeat

            return lastLines
        end tell
    end tell
end tell
"#;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(applescript)
        .output()
        .map_err(|e| format!("ターミナル出力の取得エラー: {}", e))?;

    String::from_utf8(output.stdout).map_err(|e| format!("出力のエンコードエラー: {}", e))
}

async fn send_continue_to_terminal(_terminal_app: &str) -> Result<(), String> {
    // Send "continue" text to iTerm
    let applescript = r#"
tell application "iTerm"
    tell current window
        tell current session
            write text "continue"
            -- Enterキーを送信
            write text ""
        end tell
    end tell
end tell
"#;

    Command::new("osascript")
        .arg("-e")
        .arg(applescript)
        .output()
        .map_err(|e| format!("continueコマンドの送信エラー: {}", e))?;

    Ok(())
}

#[tauri::command]
fn stop_execution(state: State<'_, AppState>) -> Result<String, String> {
    let mut is_running = state.is_running.lock().unwrap();
    let mut cancel_flag = state.cancel_flag.lock().unwrap();
    *is_running = false;
    *cancel_flag = true;
    Ok("実行を停止しました".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            is_running: Arc::new(Mutex::new(false)),
            cancel_flag: Arc::new(Mutex::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            execute_claude_command,
            stop_execution,
            check_iterm_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
