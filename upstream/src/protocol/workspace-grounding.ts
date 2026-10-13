export function appendWorkspaceRootGrounding(
  reason: string,
  workspaceRoot: string | undefined,
): string {
  if (!workspaceRoot || !workspaceRoot.trim()) return reason
  if (reason.includes("Workspace root:")) return reason
  return (
    `${reason}\nWorkspace root: ${JSON.stringify(workspaceRoot)}. ` +
    "Resolve workspace paths against exactly this root; never invent an absolute prefix, and verify uncertain paths with an available tool before using them."
  )
}
