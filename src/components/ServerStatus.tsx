import { useEffect, useState } from "react";
import { getServerInfo, type ServerInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

export function ServerStatus() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const ping = async () => {
      const nextInfo = await getServerInfo();
      if (!cancelled) {
        setInfo(nextInfo);
        setLoaded(true);
      }
    };

    void ping();
    const timer = setInterval(() => {
      void ping();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const up = loaded ? Boolean(info?.ok) : null;
  const title =
    info?.ok
      ? [`Storage: ${info.storageRoot ?? "default"}`, info.compiler ? `Compiler: ${info.compiler}` : null]
          .filter(Boolean)
          .join("\n")
      : undefined;

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" title={title}>
    </div>
  );
}
