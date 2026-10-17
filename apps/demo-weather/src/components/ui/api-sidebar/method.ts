export type MethodVariant = "get" | "post" | "put" | "delete" | "other";

// Fold an HTTP method onto its `--nb-m-*` palette key; "" for a missing method.
export function methodVariant(method: string | undefined): MethodVariant | "" {
  switch (method?.toLowerCase()) {
    case "get":
    case "head":
      return "get";
    case "post":
      return "post";
    case "put":
    case "patch":
      return "put";
    case "delete":
      return "delete";
    default:
      return method ? "other" : "";
  }
}

const abbreviations: Record<string, string> = { delete: "DEL", options: "OPT", connect: "CONN" };

// The verb a label chip shows: long verbs abbreviated to fit its fixed width.
export function methodLabel(method: string | undefined): string | undefined {
  const verb = method?.toLowerCase();
  return verb ? (abbreviations[verb] ?? verb.toUpperCase()) : undefined;
}
