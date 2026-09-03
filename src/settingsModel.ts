export type StartupSettings = {
  autostartEnabled: boolean;
  silentStart: boolean;
};

type StartupSettingsState = StartupSettings & {
  error: string | null;
};

type StartupSettingsAction =
  | { type: "loaded"; settings: StartupSettings }
  | { type: "failed"; message: string };

export const initialStartupSettings: StartupSettingsState = {
  autostartEnabled: false,
  silentStart: false,
  error: null,
};

export function startupSettingsReducer(
  state: StartupSettingsState,
  action: StartupSettingsAction,
): StartupSettingsState {
  if (action.type === "loaded") {
    return { ...action.settings, error: null };
  }
  return { ...state, error: action.message };
}
