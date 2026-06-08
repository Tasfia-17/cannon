import { InvestigationView } from "../../../components/InvestigationView";
import { ChaosPanel } from "../../../components/ChaosPanel";

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <ChaosPanel />
      <InvestigationView incidentId={id} />
    </div>
  );
}
