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
  /** Which way a first click sorts it: numbers start at the top, names at A. */
  firstDir?: "asc" | "desc";
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
  sortDir = "desc",
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
  /** Which way `sort` runs. Descending unless a table says otherwise. */
  sortDir?: "asc" | "desc";
  /** Called with the column and the direction the click asks for: the column's first, or the reverse of the current one. */
  onSort?: (key: string, dir: "asc" | "desc") => void;
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
            {columns.map((c) => {
              const sortable = Boolean(c.sortKey && onSort);
              const active = sortable && sort === c.sortKey;
              const first = c.firstDir ?? "desc";
              const next = active ? (sortDir === "asc" ? "desc" : "asc") : first;
              return (
                <TableHead
                  key={c.key}
                  className={cn(
                    "group/sort",
                    c.align === "right" || (c.align === undefined && c.key !== columns[0].key) ? "text-right" : "",
                    sortable && "cursor-pointer select-none hover:text-foreground",
                    active && "text-foreground",
                    c.className,
                  )}
                  onClick={sortable ? () => onSort!(c.sortKey!, next) : undefined}
                  // A header you can click is a control, so it can be reached and pressed
                  // from the keyboard too.
                  tabIndex={sortable ? 0 : undefined}
                  onKeyDown={
                    sortable
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSort!(c.sortKey!, next);
                          }
                        }
                      : undefined
                  }
                  aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
                >
                  {c.header}
                  {active ? (
                    <span className="ml-1 text-muted-foreground" aria-hidden>
                      {sortDir === "asc" ? "↑" : "↓"}
                    </span>
                  ) : (
                    sortable && (
                      // A faint arrow on hover, so a sortable column says so before it is clicked.
                      <span className="ml-1 text-muted-foreground opacity-0 transition-opacity group-hover/sort:opacity-50" aria-hidden>
                        {first === "asc" ? "↑" : "↓"}
                      </span>
                    )
                  )}
                </TableHead>
              );
            })}
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
