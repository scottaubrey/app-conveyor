import { YAML } from "bun";
import { AppConfigSchema } from "./schemas";
import type { AppConfig } from "./types";
import { Logger } from "./util";

export async function loadConfig(): Promise<AppConfig | null> {
  const explicitPath = process.env.CONFIG_PATH;
  const configPath = explicitPath ?? "conveyor.yaml";
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    if (explicitPath) {
      Logger.error(
        `[CONFIG] action="load" status="error" path="${configPath}" error="file_not_found"`,
      );
      process.exit(1);
    }
    return null; // conveyor.yaml absent — YAML source simply inactive
  }

  const raw = YAML.parse(await file.text());
  const result = AppConfigSchema.safeParse(raw);

  if (!result.success) {
    Logger.error(
      `[CONFIG] action="load" status="error" path="${configPath}" error="invalid_config"`,
    );
    for (const issue of result.error.issues) {
      Logger.error(
        `[CONFIG]   field="${issue.path.join(".")}" message="${issue.message}"`,
      );
    }
    process.exit(1);
  }

  Logger.log(
    `[CONFIG] action="load" status="success" path="${configPath}" pipelines=${result.data.pipelines.length}`,
  );
  return result.data;
}
