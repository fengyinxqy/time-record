use std::path::Path;

pub const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

const VALUE_NAME: &str = "com.hermes.timerecord";
const SILENT_START_ARGUMENT: &str = "--silent-start";

pub fn has_silent_start_argument(arguments: impl IntoIterator<Item = String>) -> bool {
    arguments
        .into_iter()
        .any(|argument| argument == SILENT_START_ARGUMENT)
}

pub fn startup_command(executable: &Path, silent_start: bool) -> String {
    let mut command = format!(r#""{}""#, executable.display());
    if silent_start {
        command.push(' ');
        command.push_str(SILENT_START_ARGUMENT);
    }
    command
}

pub fn is_owned_startup_command(command: &str, executable: &Path) -> bool {
    command == startup_command(executable, false) || command == startup_command(executable, true)
}

#[cfg(windows)]
fn run_key() -> Result<winreg::RegKey, std::io::Error> {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).open_subkey_with_flags(
        RUN_KEY_PATH,
        winreg::enums::KEY_QUERY_VALUE | winreg::enums::KEY_SET_VALUE,
    )
}

#[cfg(windows)]
pub fn is_enabled(executable: &Path) -> Result<bool, String> {
    let key = match run_key() {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("读取 Windows 启动项注册表失败: {error}")),
    };

    match key.get_value::<String, _>(VALUE_NAME) {
        Ok(command) => Ok(is_owned_startup_command(&command, executable)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("读取 Windows 启动项注册表值失败: {error}")),
    }
}

#[cfg(windows)]
pub fn set_enabled(executable: &Path, silent_start: bool) -> Result<(), String> {
    let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .create_subkey(RUN_KEY_PATH)
        .map_err(|error| format!("创建 Windows 启动项注册表失败: {error}"))?
        .0;

    match key.get_value::<String, _>(VALUE_NAME) {
        Ok(command) if !is_owned_startup_command(&command, executable) => {
            return Err("Windows 启动项名称已被其他启动命令占用".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("读取 Windows 启动项注册表值失败: {error}")),
    }

    key.set_value(VALUE_NAME, &startup_command(executable, silent_start))
        .map_err(|error| format!("写入 Windows 启动项注册表失败: {error}"))
}

#[cfg(windows)]
pub fn disable(executable: &Path) -> Result<(), String> {
    let key = match run_key() {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("打开 Windows 启动项注册表失败: {error}")),
    };

    match key.get_value::<String, _>(VALUE_NAME) {
        Ok(command) if is_owned_startup_command(&command, executable) => {}
        Ok(_) => return Err("Windows 启动项属于其他启动命令，未删除".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取 Windows 启动项注册表值失败: {error}")),
    }

    match key.delete_value(VALUE_NAME) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除 Windows 启动项注册表失败: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{has_silent_start_argument, is_owned_startup_command, startup_command, VALUE_NAME};
    use std::path::Path;

    #[test]
    fn uses_a_stable_application_value_name() {
        assert_eq!(VALUE_NAME, "com.hermes.timerecord");
    }

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

    #[test]
    fn accepts_only_commands_owned_by_the_current_executable() {
        let executable = Path::new(r"C:\Program Files\Time Record\time-record.exe");

        assert!(is_owned_startup_command(
            &startup_command(executable, false),
            executable
        ));
        assert!(is_owned_startup_command(
            &startup_command(executable, true),
            executable
        ));
        assert!(!is_owned_startup_command(
            r#""C:\Program Files\Other App\other.exe" --silent-start"#,
            executable
        ));
        assert!(!is_owned_startup_command(
            r#""C:\Program Files\Time Record\time-record.exe" --other"#,
            executable
        ));
        assert!(!is_owned_startup_command(
            "not a startup command",
            executable
        ));
    }
}
