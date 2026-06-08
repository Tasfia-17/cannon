import { getIncidents, getScenarios } from "../lib/api";
import { DashboardClient } from "./DashboardClient";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [incidents, scenarios] = await Promise.all([getIncidents(), getScenarios()]);
  return <DashboardClient incidents={incidents as never} scenarios={scenarios as never} />;
}
