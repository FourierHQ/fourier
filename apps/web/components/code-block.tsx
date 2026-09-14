import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

export function CodeBlock({ code, title, className }: { code: string; title?: string; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-muted/40", className)}>
      {title && (
        <div className="flex items-center justify-between border-b px-3 py-1.5">
          <span className="font-mono text-xs text-muted-foreground">{title}</span>
          <CopyButton value={code} />
        </div>
      )}
      <div className="relative">
        {!title && <CopyButton value={code} className="absolute right-1.5 top-1.5" />}
        <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
          <code className="font-mono">{code}</code>
        </pre>
      </div>
    </div>
  );
}
