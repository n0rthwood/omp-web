import { NextResponse } from "next/server";
import { homedir } from "os";
// Intentionally NOT visibility-gated (issue #7): the home path only powers the
// `~` prefix display in the directory picker — it reveals no directory
// contents and restricted users cannot browse outside their visible roots.
export async function GET() {
  return NextResponse.json({ home: homedir() });
}
