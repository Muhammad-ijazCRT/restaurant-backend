export type DatabaseConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

export function getRootDatabaseName(config: DatabaseConfig): string {
  return config.database === "mysql" ? "mysql" : "information_schema";
}

/** Database settings from environment (never commit real values in .env). */
export function getDatabaseConfig(): DatabaseConfig {
  const database = process.env.DB_NAME;
  if (!database) {
    throw new Error("DB_NAME is required in .env.");
  }

  return {
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? "3306"),
    user: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "",
    database,
  };
}

export function getMysqlConnectionUrl(config: DatabaseConfig): string {
  const user = encodeURIComponent(config.user);
  const auth = config.password
    ? `${user}:${encodeURIComponent(config.password)}`
    : user;
  return `mysql://${auth}@${config.host}:${config.port}/${encodeURIComponent(config.database)}`;
}
