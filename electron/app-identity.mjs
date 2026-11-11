import { join } from "node:path";

export function configureAppIdentity(app) {
  app.setName("DoneBot");
  app.setPath("userData", app.commandLine.getSwitchValue("user-data-dir") || join(app.getPath("appData"), "DoneBot"));
  app.setPath("sessionData", app.getPath("userData"));
  app.setAppLogsPath(join(app.getPath("userData"), "logs"));
}
