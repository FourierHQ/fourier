"use client";

import type { ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Right-aligned and tabular by default; the first column is the label. */
  align?: "left" | "right";
  cell: (row: T) => ReactNode;
  /** Set when this column can be sorted, and the value the API expects. */
  sortKey?: string;
  className?: string;
}

/**
 * The ranked table: the workhorse of this section.
 *
 * A bar behind the label, proportional to the row's share of the period, so the shape
 * of the distribution is readable without giving up the exact numbers a table is for.
 * The bar sits underneath the text rather than in its own column — it is an aid to
 * scanning, not a second rendering of a number already on the row.
 */
export function RankedTable<T>({
  rows,
  columns,
  loading,
  barOf,
  onSelect,
  rowKey,
  sort,
  onSort,
  empty,
  caption,
}: {
  rows: T[] | undefined;
  columns: Column<T>[];
  loading?: boolean;
  /** 0–1, how far the bar behind the first column extends. */
  barOf?: (row: T) => number;
  onSelect?: (row: T) => void;
  rowKey: (row: T) => string;
  sort?: string;
  onSort?: (key: string) => void;
  empty?: ReactNode;
  caption?: ReactNode;
}) {
  if (loading && !rows) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );
  }
  if (!rows?.length) return <>{empty}</>;

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead
                key={c.key}
                className={cn(
                  c.align === "right" || (c.align === undefined && c.key !== columns[0].key) ? "text-right" : "",
                  c.sortKey && onSort && "cursor-pointer select-none hover:text-foreground",
                  c.className,
                )}
                onClick={c.sortKey && onSort ? () => onSort(c.sortKey!) : undefined}
                aria-sort={c.sortKey && sort === c.sortKey ? "descending" : undefined}
              >
                {c.header}
                {c.sortKey && sort === c.sortKey && <span className="ml-1 text-muted-foreground">↓</span>}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const share = barOf ? Math.max(Math.min(barOf(row), 1), 0) : 0;
            return (
              <TableRow
                key={rowKey(row)}
                className={cn(onSelect && "cursor-pointer")}
                onClick={onSelect ? () => onSelect(row) : undefined}
                tabIndex={onSelect ? 0 : undefined}
                onKeyDown={onSelect ? (e) => (e.key === "Enter" ? onSelect(row) : undefined) : undefined}
              >
                {columns.map((c, i) => (
                  <TableCell
                    key={c.key}
                    className={cn(
                      "relative",
                      c.align === "right" || (c.align === undefined && i > 0) ? "text-right tabular-nums" : "",
                      c.className,
                    )}
                  >
                    {i === 0 && barOf && (
                      <span
                        className="pointer-events-none absolute inset-y-1 left-0 -z-10 rounded-sm bg-primary/10"
                        style={{ width: `${Math.max(share * 100, 0.5)}%` }}
                        aria-hidden
                      />
                    )}
                    {c.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {caption && <p className="border-t px-6 py-2 text-xs text-muted-foreground">{caption}</p>}
    </>
  );
}
