import { cn } from "@/lib/utils";

interface ValidationBadgeProps {
  errorCount: number;
  warningCount: number;
  className?: string;
}

/**
 * Small badge overlay showing validation error/warning count.
 * Red for errors, orange for warnings.
 */
export function ValidationBadge({ errorCount, warningCount, className }: ValidationBadgeProps) {
  const totalCount = errorCount + warningCount;

  if (totalCount === 0) return null;

  // Errors take priority (red), otherwise warnings (orange)
  const isError = errorCount > 0;

  return (
    <span
      className={cn(
        "absolute -top-1.5 -right-1.5 flex items-center justify-center",
        "min-w-[16px] h-[16px] px-1 rounded-full text-[9px] font-bold leading-none",
        isError
          ? "bg-destructive text-destructive-foreground"
          : "bg-orange-500 text-white",
        className
      )}
    >
      {totalCount > 99 ? '99+' : totalCount}
    </span>
  );
}
