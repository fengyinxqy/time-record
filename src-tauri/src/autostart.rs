pub const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

const VALUE_NAME: &str = "时间记录";
const SILENT_START_ARGUMENT: &str = "--silent-start";

pub fn has_silent_start_argument(arguments: impl IntoIterator<Item = String>) -> bool {
    arguments
        .into_iter()
        .any(|argument| argument == SILENT_START_ARGUMENT)
}

pub fn startup_command(executable: &std::path::Path, silent_start: bool) -> String {
    let mut command = format!(r#""{}""#, executable.display());
    if silent_start {
        command.push(' ');
        command.push_str(SILENT_START_ARGUMENT);
    }
    command
}

#[cfg(windows)]
fn run_key() -> Result<winreg::RegKey, std::io::Error> {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).open_subkey_with_flags(
        RUN_KEY_PATH,
        winreg::enums::KEY_QUERY_VALUE | winreg::enums::KEY_SET_VALUE,
    )
}

#[cfg(windows)]
pub fn is_enabled() -> Result<bool, String> {
    match winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).open_subkey(RUN_KEY_PATH) {
        Ok(key) => match key.get_raw_value(VALUE_NAME) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("读取 Windows 启动项注册表值失败: {error}")),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("读取 Windows 启动项注册表失败: {error}")),
    }
}

#[cfg(windows)]
pub fn set_enabled(executable: &std::path::Path, silent_start: bool) -> Result<(), String> {
    let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .create_subkey(RUN_KEY_PATH)
        .map_err(|error| format!("创建 Windows 启动项注册表失败: {error}"))?
        .0;
    key.set_value(VALUE_NAME, &startup_command(executable, silent_start))
        .map_err(|error| format!("写入 Windows 启动项注册表失败: {error}"))
}

#[cfg(windows)]
pub fn set_enabled_without_executable(enabled: bool) -> Result<(), String> {
    if enabled {
        return Err("启用 Windows 开机自启动需要可执行文件路径".to_string());
    }

    let key = match run_key() {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("打开 Windows 启动项注册表失败: {error}")),
    };
    match key.delete_value(VALUE_NAME) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除 Windows 启动项注册表失败: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{has_silent_start_argument, startup_command};
    use std::path::Path;

    #[test]
    fn recognizes_only_the_silent_start_flag() {
        assert!(has_silent_start_argument(
            vec!["--silent-start".to_string()]
        ));
        assert!(has_silent_start_argument(vec![
            "--other".to_string(),
            "--silent-start".to_string(),
        ]));
        assert!(!has_silent_start_argument(vec![
            "--silent-start=true".to_string()
        ]));
        assert!(!has_silent_start_argument(vec!["silent-start".to_string()]));
    }

    #[test]
    fn builds_a_quoted_command_for_a_path_with_spaces() {
        let executable = Path::new(r"C:\Program Files\Time Record\time-record.exe");

        assert_eq!(
            startup_command(executable, false),
            r#""C:\Program Files\Time Record\time-record.exe""#
        );
        assert_eq!(
            startup_command(executable, true),
            r#""C:\Program Files\Time Record\time-record.exe" --silent-start"#
        );
    }
}
