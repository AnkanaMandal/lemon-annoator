import { type NextRequest, NextResponse } from "next/server";

// Lemon only serves this machine. Rejecting requests whose Host isn't local stops a malicious web
// page from using DNS rebinding to reach the API (projects, presigned URLs) through this server.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostname(host: string | null): string {
  if (!host) return "";
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1); // [::1]:3000
  return h.split(":")[0];
}

export function proxy(request: NextRequest) {
  if (!LOCAL_HOSTS.has(hostname(request.headers.get("host")))) {
    return NextResponse.json(
      {
        error: {
          code: "FORBIDDEN_HOST",
          message: "Lemon only accepts requests from this computer.",
          hint: null,
          details: {},
        },
      },
      { status: 403 },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
