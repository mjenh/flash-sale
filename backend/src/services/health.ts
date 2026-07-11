// Health service: framework-free, dependencies injected (layering rule AD-7).

export interface HealthDeps {
  redisPing: () => Promise<string>;
  mongoReady: () => boolean;
}

export interface HealthReport {
  status: "ok" | "degraded";
  redis: boolean;
  mongo: boolean;
}

export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  let redis = false;
  try {
    redis = (await deps.redisPing()) === "PONG";
  } catch {
    redis = false;
  }
  const mongo = deps.mongoReady();
  return { status: redis && mongo ? "ok" : "degraded", redis, mongo };
}
