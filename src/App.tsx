import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import iconImage from "./assets/icon.png";

interface ScheduleSettings {
  executionTime: string; // HH:MM format
  targetDirectory: string;
  claudeOptions: string;
  claudeCommand: string;
  autoRetryOnRateLimit: boolean;
  useNewITermWindow: boolean;
}

interface ExecutionResult {
  status: string;
  terminalOutput?: string;
  needsRetry?: boolean;
  retryTime?: string;
}

interface ITermStatus {
  is_installed: boolean;
  is_running: boolean;
}

function App() {
  const now = new Date();
  const defaultTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes() + 1).padStart(2, "0")}`;

  const [settings, setSettings] = useState<ScheduleSettings>(() => {
    // Load saved settings from localStorage
    const saved = localStorage.getItem("claudeRunnerSettings");
    if (saved) {
      const parsed = JSON.parse(saved);
      // Always use current time for executionTime
      parsed.executionTime = defaultTime;
      // Add default for new properties that might not exist in old saved data
      if (parsed.useNewITermWindow === undefined) {
        parsed.useNewITermWindow = true;
      }
      return parsed;
    }
    return {
      executionTime: defaultTime,
      targetDirectory: "",
      claudeOptions: "--model opus",
      claudeCommand: "",
      autoRetryOnRateLimit: false,
      useNewITermWindow: true,
    };
  });

  const [isRunning, setIsRunning] = useState(false);
  const [countdown, setCountdown] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [claudeCodeStatus, setClaudeCodeStatus] = useState<string>("");
  const [executionPhase, setExecutionPhase] = useState<
    "waiting" | "checking" | null
  >(null);
  const [executionStartTime, setExecutionStartTime] = useState<number | null>(
    null,
  );
  const [checkingStartTime, setCheckingStartTime] = useState<number | null>(
    null,
  );
  const [iTermStatus, setITermStatus] = useState<ITermStatus | null>(null);
  const [checkingITerm, setCheckingITerm] = useState(false);
  const [rescheduledTime, setRescheduledTime] = useState<string | null>(null);

  // Save settings to localStorage when they change
  useEffect(() => {
    localStorage.setItem("claudeRunnerSettings", JSON.stringify(settings));
  }, [settings]);

  // Listen for execution started event from backend
  useEffect(() => {
    const unlisten = listen("execution-started", () => {
      setExecutionPhase("checking");
      setStatus(
        settings.autoRetryOnRateLimit
          ? "Claude Code 実行中 - Rate limit監視中..."
          : "Claude Code 動作ステータス取得待機中",
      );
      setCheckingStartTime(new Date().getTime());
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for terminal output updates
  useEffect(() => {
    const unlisten = listen<string>("terminal-output", (event) => {
      setClaudeCodeStatus(event.payload);

      // Rate limitを検出したときにステータスを更新
      if (event.payload.includes("Rate limit detected")) {
        const timeMatch = event.payload.match(/(\d{2}):01/);
        const remainingMatch = event.payload.match(/残り約(\d+)分/);

        if (timeMatch && remainingMatch) {
          const scheduledTime = timeMatch[0];
          const remainingMinutes = parseInt(remainingMatch[1]);
          const hours = Math.floor(remainingMinutes / 60);
          const minutes = remainingMinutes % 60;

          if (hours > 0) {
            setStatus(
              `Rate limit検出 - ${scheduledTime}に再実行予定 (残り約${hours}時間${minutes}分)`,
            );
          } else {
            setStatus(
              `Rate limit検出 - ${scheduledTime}に再実行予定 (残り約${minutes}分)`,
            );
          }
        }
      } else if (event.payload.includes("Claude usage limit reached")) {
        const resetMatch = event.payload.match(/reset at (\d+(?:am|pm))/i);
        const resetTime = resetMatch ? resetMatch[1] : "指定時刻";

        // 残り時間を抽出
        const timeMatch = event.payload.match(/残り約(\d+)分/);
        if (timeMatch) {
          const remainingMinutes = parseInt(timeMatch[1]);
          const hours = Math.floor(remainingMinutes / 60);
          const minutes = remainingMinutes % 60;

          if (hours > 0) {
            setStatus(
              `Rate limit検出 - ${resetTime}まで待機中 (残り約${hours}時間${minutes}分)`,
            );
          } else {
            setStatus(
              `Rate limit検出 - ${resetTime}まで待機中 (残り約${minutes}分)`,
            );
          }
        } else {
          setStatus(`Rate limit検出 - ${resetTime}まで待機中...`);
        }
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for rate limit retry scheduled event
  useEffect(() => {
    const unlisten = listen<string>("rate-limit-retry-scheduled", (event) => {
      setRescheduledTime(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!isRunning) return;

    const intervalId = setInterval(() => {
      const now = new Date();

      if (executionPhase === "checking") {
        if (settings.autoRetryOnRateLimit) {
          // Auto-retry mode: show monitoring status
          if (!checkingStartTime) {
            setCheckingStartTime(now.getTime());
          }

          // Rate limitメッセージを検出して表示
          if (
            claudeCodeStatus.includes("Rate limit detected") &&
            rescheduledTime
          ) {
            // 再スケジュールされた時刻までのカウントダウン
            const [hours, minutes] = rescheduledTime.split(":").map(Number);
            const target = new Date();
            target.setHours(hours, minutes, 0, 0);

            // 過去の時刻なら翌日に設定
            if (target.getTime() <= now.getTime()) {
              target.setDate(target.getDate() + 1);
            }

            const distance = target.getTime() - now.getTime();
            const countdownHours = Math.floor(
              (distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
            );
            const countdownMinutes = Math.floor(
              (distance % (1000 * 60 * 60)) / (1000 * 60),
            );
            const countdownSeconds = Math.floor(
              (distance % (1000 * 60)) / 1000,
            );
            setCountdown(
              `${countdownHours}時間 ${countdownMinutes}分 ${countdownSeconds}秒`,
            );
          } else if (claudeCodeStatus.includes("Claude usage limit reached")) {
            // Rate limit resetの時間を抽出
            const resetMatch = claudeCodeStatus.match(
              /reset at (\d+(?:am|pm))/i,
            );
            const resetTime = resetMatch ? resetMatch[1] : "指定時刻";

            // Rate limitステータスから時間情報を取得
            if (claudeCodeStatus.includes("Rate limit:")) {
              const timeMatch = claudeCodeStatus.match(/残り約(\d+)分/);
              if (timeMatch) {
                const remainingMinutes = parseInt(timeMatch[1]);
                const hours = Math.floor(remainingMinutes / 60);
                const minutes = remainingMinutes % 60;
                const seconds = 0; // 秒は0と仮定
                setCountdown(`${hours}時間 ${minutes}分 ${seconds}秒`);
              } else {
                setCountdown(`${resetTime}まで待機中...`);
              }
            } else {
              setCountdown(`${resetTime}まで待機中...`);
            }
          } else {
            // 1分ごとの監視サイクルのカウントダウン
            const elapsedSeconds = Math.floor(
              (now.getTime() - (checkingStartTime || now.getTime())) / 1000,
            );
            const currentCycleSeconds = elapsedSeconds % 60;
            const remainingSeconds = 60 - currentCycleSeconds;

            setCountdown(`次の確認まで: ${remainingSeconds}秒`);
          }
        } else {
          if (!checkingStartTime) {
            setCheckingStartTime(now.getTime());
            return;
          }

          const elapsedSeconds = Math.floor(
            (now.getTime() - checkingStartTime) / 1000,
          );
          const remainingSeconds = Math.max(0, 120 - elapsedSeconds);

          if (remainingSeconds <= 0) {
            setCountdown("待機完了");
            return;
          }

          const minutes = Math.floor(remainingSeconds / 60);
          const seconds = remainingSeconds % 60;
          setCountdown(`${minutes}分 ${seconds}秒`);
        }
      } else if (executionPhase === "waiting" && isRunning) {
        // 実行時刻までのカウントダウン
        const [hours, minutes] = settings.executionTime.split(":").map(Number);
        const target = new Date();
        target.setHours(hours, minutes, 0, 0);

        // 初回実行時のみ、過去の時刻なら翌日に設定
        if (!executionStartTime && target.getTime() <= now.getTime()) {
          target.setDate(target.getDate() + 1);
        }

        const distance = target.getTime() - now.getTime();

        if (distance <= 0) {
          setCountdown("実行中...");
          setExecutionStartTime(now.getTime());
        } else {
          const hours = Math.floor(
            (distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
          );
          const minutes = Math.floor(
            (distance % (1000 * 60 * 60)) / (1000 * 60),
          );
          const seconds = Math.floor((distance % (1000 * 60)) / 1000);
          setCountdown(`${hours}時間 ${minutes}分 ${seconds}秒`);
        }
      }
    }, 1000);

    return () => clearInterval(intervalId);
  }, [
    isRunning,
    executionPhase,
    settings.executionTime,
    executionStartTime,
    checkingStartTime,
    rescheduledTime,
    claudeCodeStatus,
  ]);

  async function startExecution() {
    // Check if iTerm is installed
    if (!iTermStatus?.is_installed) {
      setStatus("エラー: iTermがインストールされていません");
      return;
    }

    // Validate inputs
    if (!settings.claudeCommand.trim()) {
      setStatus("エラー: Claude Codeで実行する命令を入力してください");
      return;
    }

    // Only validate directory for new window mode
    if (settings.useNewITermWindow && !settings.targetDirectory.trim()) {
      setStatus("エラー: 実行対象ディレクトリを選択してください");
      return;
    }

    setIsRunning(true);
    setStatus("待機中...");
    setClaudeCodeStatus("");
    setExecutionPhase("waiting");
    setExecutionStartTime(null);
    setCheckingStartTime(null);
    setRescheduledTime(null);

    // Debug logging
    console.log("Invoking execute_claude_command with:", {
      executionTime: settings.executionTime,
      targetDirectory: settings.targetDirectory,
      claudeOptions: settings.claudeOptions,
      claudeCommand: settings.claudeCommand,
      autoRetryOnRateLimit: settings.autoRetryOnRateLimit,
      useNewWindow: settings.useNewITermWindow,
    });

    // Start the backend execution in parallel
    const executionPromise = invoke<ExecutionResult>("execute_claude_command", {
      executionTime: settings.executionTime,
      targetDirectory: settings.targetDirectory,
      claudeOptions: settings.claudeOptions,
      claudeCommand: settings.claudeCommand,
      autoRetryOnRateLimit: settings.autoRetryOnRateLimit,
      useNewWindow: settings.useNewITermWindow,
    });

    // Handle the result when it eventually comes back
    executionPromise
      .then((result) => {
        console.log("Execution result received:", result);

        if (result.terminalOutput) {
          setClaudeCodeStatus(result.terminalOutput);
        }

        if (result.status === "cancelled") {
          setStatus("実行を中止しました");
        } else if (result.status && result.status.startsWith("completed_in_")) {
          // Extract processing time from status
          const timeMatch = result.status.match(/completed_in_(\d+)m(\d+)s/);
          if (timeMatch) {
            const minutes = timeMatch[1];
            const seconds = timeMatch[2];
            setStatus(`処理完了 (処理時間: ${minutes}分${seconds}秒)`);
          } else {
            setStatus("処理完了");
          }
        } else if (result.status === "rate_limit_detected") {
          setStatus("Rate limitを検出したため終了しました");
        } else if (settings.autoRetryOnRateLimit) {
          // When auto-retry is enabled, this shouldn't normally be reached
          setStatus("監視を終了しました");
        } else {
          // Original behavior for non-auto-retry mode
          if (result.needsRetry) {
            setStatus(`実行完了 - ${result.retryTime}に再実行予定`);
          } else {
            setStatus("実行完了");
          }
        }
      })
      .catch((error) => {
        setStatus(`エラー: ${error}`);
      })
      .finally(() => {
        setIsRunning(false);
        setExecutionPhase(null);
        setExecutionStartTime(null);
        setCheckingStartTime(null);
        setRescheduledTime(null);
        setCountdown("");
      });
  }

  async function stopExecution() {
    try {
      await invoke("stop_execution");
      setIsRunning(false);
      setExecutionPhase(null);
      setExecutionStartTime(null);
      setCheckingStartTime(null);
      setRescheduledTime(null);
      setStatus("実行を中止しました");
    } catch (error) {
      setStatus(`停止エラー: ${error}`);
    }
  }

  function setCurrentTimePlusOneMinute() {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 1);
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    setSettings({ ...settings, executionTime: `${hours}:${minutes}` });
  }

  function setNextHour01() {
    const [currentHours] = settings.executionTime.split(":").map(Number);
    const nextHour = (currentHours + 1) % 24;
    const hours = String(nextHour).padStart(2, "0");
    setSettings({ ...settings, executionTime: `${hours}:01` });
  }

  async function selectDirectory() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: settings.targetDirectory,
        title: "実行対象ディレクトリを選択",
      });

      if (selected && typeof selected === "string") {
        setSettings({ ...settings, targetDirectory: selected });
      }
    } catch (error) {
      console.error("Directory selection error:", error);
      setStatus(`フォルダ選択エラー: ${error}`);
    }
  }

  async function checkITermStatus() {
    setCheckingITerm(true);
    try {
      const status = await invoke<ITermStatus>("check_iterm_status");
      setITermStatus(status);
    } catch (error) {
      console.error("Failed to check iTerm status:", error);
      setStatus(`iTerm状態確認エラー: ${error}`);
    } finally {
      setCheckingITerm(false);
    }
  }

  // Check iTerm status on component mount
  useEffect(() => {
    checkITermStatus();
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
      <div className="px-6 py-5 bg-gradient-to-r from-blue-600 to-blue-700 dark:from-blue-700 dark:to-blue-800">
        <div className="flex items-center gap-3">
          <img src={iconImage} alt="Claude Code Runner" className="w-10 h-10" />
          <h1 className="text-2xl font-bold text-white">Claude Code Runner</h1>
        </div>
      </div>
      <div className="p-8">
        <div className="space-y-6">
          <div>
            <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">
              実行時刻
            </label>
            <div className="flex gap-3 items-center">
              <input
                type="time"
                value={settings.executionTime}
                onChange={(e) =>
                  setSettings({ ...settings, executionTime: e.target.value })
                }
                className="w-32 px-4 py-3 text-base font-medium bg-gray-50 border-2 border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 focus:border-blue-500 transition-colors duration-200 dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={isRunning}
              />
              <button
                type="button"
                onClick={setCurrentTimePlusOneMinute}
                className="px-6 py-3 font-medium text-white bg-gradient-to-r from-emerald-500 to-green-600 rounded-2xl shadow-lg hover:shadow-xl hover:from-emerald-600 hover:to-green-700 transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-green-300 focus:ring-opacity-50 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={isRunning}
              >
                現在時刻+1分
              </button>
              <button
                type="button"
                onClick={setNextHour01}
                className="px-6 py-3 font-medium text-white bg-gradient-to-r from-blue-500 to-indigo-600 rounded-2xl shadow-lg hover:shadow-xl hover:from-blue-600 hover:to-indigo-700 transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-blue-300 focus:ring-opacity-50 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={isRunning}
              >
                次の{" "}
                {String(
                  (parseInt(settings.executionTime.split(":")[0]) + 1) % 24,
                ).padStart(2, "0")}
                :01分
              </button>
            </div>
          </div>

          {settings.useNewITermWindow && (
            <>
              <div>
                <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">
                  実行対象ディレクトリ
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={settings.targetDirectory}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        targetDirectory: e.target.value,
                      })
                    }
                    className="flex-1 px-4 py-3 text-sm bg-gray-50 border-2 border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 focus:border-blue-500 transition-colors duration-200 dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={isRunning}
                    readOnly
                  />
                  <button
                    type="button"
                    onClick={selectDirectory}
                    className="px-6 py-3 font-medium text-white bg-gradient-to-r from-purple-500 to-purple-600 rounded-2xl shadow-lg hover:shadow-xl hover:from-purple-600 hover:to-purple-700 transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-purple-300 focus:ring-opacity-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={isRunning}
                  >
                    フォルダ選択
                  </button>
                </div>
              </div>

              <div>
                <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">
                  Claudeコマンドのオプション
                </label>
                <input
                  type="text"
                  value={settings.claudeOptions}
                  onChange={(e) =>
                    setSettings({ ...settings, claudeOptions: e.target.value })
                  }
                  className="w-full px-4 py-3 text-sm bg-gray-50 border-2 border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 focus:border-blue-500 transition-colors duration-200 dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isRunning}
                />
              </div>
            </>
          )}

          <div>
            <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">
              Claude Codeで実行する命令
            </label>
            <div className="relative">
              <input
                type="text"
                value={settings.claudeCommand}
                onChange={(e) =>
                  setSettings({ ...settings, claudeCommand: e.target.value })
                }
                className="w-full px-4 py-3 pr-12 text-sm bg-gray-50 border-2 border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 focus:border-blue-500 transition-colors duration-200 dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={isRunning}
              />
              <button
                type="button"
                onClick={() => setSettings({ ...settings, claudeCommand: "" })}
                className="absolute right-2 top-1/2 transform -translate-y-1/2 p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={isRunning}
                title="クリア"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">
                iTerm ステータス
              </label>
              {iTermStatus ? (
                iTermStatus.is_installed ? (
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-3 h-3 rounded-full ${
                        iTermStatus.is_running ? "bg-green-500" : "bg-gray-400"
                      }`}
                    ></div>
                    <span className="text-sm text-gray-700 dark:text-gray-300">
                      {iTermStatus.is_running ? "起動中" : "未起動"}
                    </span>
                    <button
                      type="button"
                      onClick={checkITermStatus}
                      className="ml-2 w-8 h-8 flex items-center justify-center rounded-full bg-gradient-to-r from-blue-500 to-blue-600 text-white hover:from-blue-600 hover:to-blue-700 transition-colors duration-200 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={isRunning || checkingITerm}
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                      </svg>
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-red-500"></div>
                    <span className="text-sm text-red-600 dark:text-red-400 font-medium">
                      インストールされていません
                    </span>
                    <button
                      type="button"
                      onClick={checkITermStatus}
                      className="ml-2 w-8 h-8 flex items-center justify-center rounded-full bg-gradient-to-r from-blue-500 to-blue-600 text-white hover:from-blue-600 hover:to-blue-700 transition-colors duration-200 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={isRunning || checkingITerm}
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                      </svg>
                    </button>
                  </div>
                )
              ) : (
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-gray-400 animate-pulse"></div>
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    確認中...
                  </span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">
                  iTerm ウィンドウ設定
                </label>
                <div className="space-y-2">
                  <div className="flex items-center">
                    <input
                      type="radio"
                      id="useNewWindow"
                      name="windowOption"
                      value="new"
                      checked={settings.useNewITermWindow}
                      onChange={() =>
                        setSettings({
                          ...settings,
                          useNewITermWindow: true,
                        })
                      }
                      className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                      disabled={isRunning}
                    />
                    <label
                      htmlFor="useNewWindow"
                      className="ml-2 text-sm font-medium text-gray-900 dark:text-white"
                    >
                      新規ウィンドウ利用
                    </label>
                  </div>
                  <div className="flex items-center">
                    <input
                      type="radio"
                      id="useExistingWindow"
                      name="windowOption"
                      value="existing"
                      checked={!settings.useNewITermWindow}
                      onChange={() =>
                        setSettings({
                          ...settings,
                          useNewITermWindow: false,
                        })
                      }
                      className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                      disabled={isRunning}
                    />
                    <div className="ml-2">
                      <label
                        htmlFor="useExistingWindow"
                        className="text-sm font-medium text-gray-900 dark:text-white"
                      >
                        既存ウィンドウ利用 (既存ウィンドウに命令を送信)
                      </label>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        ※claude codeを実行状態にしておいてください。
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">
                  実行後 rate limit を検出したら
                </label>
                <div className="space-y-2">
                  <div className="flex items-center">
                    <input
                      type="radio"
                      id="autoRetryEnabled"
                      name="rateLimitOption"
                      value="auto"
                      checked={settings.autoRetryOnRateLimit}
                      onChange={() =>
                        setSettings({
                          ...settings,
                          autoRetryOnRateLimit: true,
                        })
                      }
                      className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                      disabled={isRunning}
                    />
                    <label
                      htmlFor="autoRetryEnabled"
                      className="ml-2 text-sm font-medium text-gray-900 dark:text-white"
                    >
                      rate limit 解除後に自動実行する
                    </label>
                  </div>
                  <div className="flex items-center">
                    <input
                      type="radio"
                      id="autoRetryDisabled"
                      name="rateLimitOption"
                      value="stop"
                      checked={!settings.autoRetryOnRateLimit}
                      onChange={() =>
                        setSettings({
                          ...settings,
                          autoRetryOnRateLimit: false,
                        })
                      }
                      className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                      disabled={isRunning}
                    />
                    <label
                      htmlFor="autoRetryDisabled"
                      className="ml-2 text-sm font-medium text-gray-900 dark:text-white"
                    >
                      終了する
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="pt-4">
            <div className="flex items-center gap-2 mb-3 text-sm text-gray-600 dark:text-gray-400">
              <svg
                className="w-5 h-5 text-blue-600 dark:text-blue-400"
                fill="currentColor"
                viewBox="0 0 20 20"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                  clipRule="evenodd"
                />
              </svg>
              <span>
                プライバシーとセキュリティ &gt; アクセシビリティ
                にて、このアプリを追加し有効化してください
              </span>
            </div>
            {!isRunning ? (
              <button
                type="button"
                onClick={startExecution}
                className="w-full px-6 py-3 font-medium text-white bg-gradient-to-r from-blue-500 to-indigo-600 rounded-2xl shadow-lg hover:shadow-xl hover:from-blue-600 hover:to-indigo-700 transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-blue-300 focus:ring-opacity-50 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!iTermStatus?.is_installed}
              >
                <svg
                  className="w-5 h-5 inline-block mr-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                開始
              </button>
            ) : (
              <button
                type="button"
                onClick={stopExecution}
                className="w-full px-6 py-3 font-medium text-white bg-gradient-to-r from-red-500 to-red-800 rounded-2xl shadow-lg hover:shadow-xl hover:from-red-600 hover:to-red-700 transition-all duration-200 focus:outline-none focus:ring-4 focus:ring-red-300 focus:ring-opacity-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg
                  className="w-5 h-5 inline-block mr-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
                  />
                </svg>
                停止
              </button>
            )}
          </div>

          {isRunning && countdown && (
            <div className="mt-6 p-4 text-center bg-blue-50 dark:bg-blue-900 rounded-lg border-2 border-blue-200 dark:border-blue-700">
              <p className="text-lg font-semibold text-blue-800 dark:text-blue-200">
                残り時間: {countdown}
              </p>
            </div>
          )}

          {status && (
            <div
              className={`mt-4 p-4 rounded-lg border-2 transition-all duration-300 ${
                status.includes("エラー")
                  ? "text-red-700 bg-red-50 border-red-200 dark:bg-red-900 dark:text-red-200 dark:border-red-700"
                  : status.includes("完了")
                    ? "text-green-700 bg-green-50 border-green-200 dark:bg-green-900 dark:text-green-200 dark:border-green-700"
                    : "text-gray-700 bg-gray-50 border-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600"
              }`}
            >
              <p className="font-medium">ステータス: {status}</p>
            </div>
          )}

          {claudeCodeStatus && (
            <div>
              <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">
                Claude Code Status
              </label>
              <div className="p-4 bg-black text-gray-100 rounded-lg font-mono text-xs overflow-auto max-h-48 border-2 border-gray-700 shadow-inner">
                <pre className="whitespace-pre-wrap leading-relaxed">
                  {claudeCodeStatus}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default App;
