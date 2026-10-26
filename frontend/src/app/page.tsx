import { Dashboard } from "@/components/dashboard/dashboard";

// Sign-in happens in the browser (AuthGate), so the server never renders signed-in pages and
// instant-navigation validation can't check them.
export const instant = false;

export default function HomePage() {
  return <Dashboard />;
}
