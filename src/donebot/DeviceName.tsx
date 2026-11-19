import { useStore } from "@/state/store";
import { AdminOnly } from "@/components/AdminOnly";
import { ComputerNameRow } from "@/components/ComputerNameRow";

export function DoneBotDeviceName() {
  const { state, dispatch } = useStore();
  return <AdminOnly><ComputerNameRow saved={state.config?.computerName ?? ""} className="px-4 py-[13px]" onSaved={computerName => {
    if (state.config) dispatch({ type: "configStatus", config: { ...state.config, computerName } });
  }} /></AdminOnly>;
}
