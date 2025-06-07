import fs from "fs/promises";
import path from "path";

// 現在の日付からバージョン文字列を生成
function generateVersionString() {
  const now = new Date();
  // 年の下2桁を取得
  const year = String(now.getFullYear()).slice(-2);
  // 月と日を2桁で取得 (ゼロパディングするとエラーになるので注意)
  const month = String(now.getMonth() + 1);
  const day = String(now.getDate());

  return `${year}.${month}.${day}`;
}

// JSON設定ファイルを更新
async function updateJsonConfigFile(filePath, version, field = null) {
  const data = await fs.readFile(filePath, "utf8");
  const config = JSON.parse(data);

  if (field) {
    if (!config[field]) {
      throw new Error(`Field ${field} not found in ${filePath}`);
    }
    config[field].version = version;
  } else {
    config.version = version;
  }

  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// Cargo.toml設定ファイルを更新
async function updateCargoToml(filePath, version) {
  const data = await fs.readFile(filePath, "utf8");
  const updatedData = data.replace(
    /^(version\s*=\s*)"[^"]*"/m,
    `$1"${version}"`,
  );
  await fs.writeFile(filePath, updatedData, "utf8");
}

async function updateVersion() {
  try {
    // バージョン文字列を生成
    const version = generateVersionString();

    // 設定ファイルを更新
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const tauriConfigPath = path.join(
      process.cwd(),
      "src-tauri",
      "tauri.conf.json",
    );
    const cargoTomlPath = path.join(process.cwd(), "src-tauri", "Cargo.toml");

    await updateJsonConfigFile(packageJsonPath, version);
    await updateJsonConfigFile(tauriConfigPath, version);
    await updateCargoToml(cargoTomlPath, version);
  } catch (err) {
    console.error("An error occurred:", err);
  }
}

updateVersion();
