import Dashboard from "@/components/Dashboard";
import { gateEnabled } from "@/lib/auth";

export default function Home() {
  return <Dashboard lockable={gateEnabled()} />;
}
