import { useState, type ReactNode } from "react";

export function Crown({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
      <path d="M3 20 L5 6 L11 13 L16 3 L21 13 L27 6 L29 20 Z" />
      <path d="M3 22.5 H29" />
    </svg>
  );
}

export function Card({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`gold-card p-4 ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold/90"><Crown className="h-3 w-4" />{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Tile({ label, value, sub, tone = "", onClick }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; onClick?: () => void }) {
  const body = (
    <>
      <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </>
  );
  return onClick ? (
    <button onClick={onClick} className="gold-card gold-hover p-3 text-left">{body}</button>
  ) : (
    <div className="gold-card p-3">{body}</div>
  );
}

export function Pill({ children, kind = "muted" }: { children: ReactNode; kind?: "long" | "short" | "gold" | "muted" | "good" | "bad" }) {
  const cls = {
    long: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    short: "border-rose-500/40 bg-rose-500/10 text-rose-300",
    gold: "border-gold/50 bg-gold/10 text-gold",
    muted: "border-border bg-white/5 text-muted-foreground",
    good: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    bad: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  }[kind];
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${cls}`}>{children}</span>;
}

export function Table({ head, rows, onRow, empty = "Пока пусто." }: { head: ReactNode[]; rows: ReactNode[][]; onRow?: (i: number) => void; empty?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            {head.map((h, i) => <th key={i} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} onClick={onRow ? () => onRow(i) : undefined}
              className={`border-t border-border/70 ${onRow ? "cursor-pointer hover:bg-gold/5" : ""}`}>
              {r.map((c, j) => <td key={j} className="whitespace-nowrap px-2 py-1.5 tabular-nums">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="px-2 py-4 text-sm text-muted-foreground">{empty}</p>}
    </div>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-full border border-gold/30">
      {options.map(([v, l]) => (
        <button key={String(v)} onClick={() => onChange(v)}
          className={`px-3 py-1 text-xs transition ${value === v ? "bg-gold text-black" : "text-muted-foreground hover:text-gold"}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** A table column: header, cell, and (optional) the value it sorts by. */
export type Col<T> = { head: string; cell: (r: T) => ReactNode; sort?: (r: T) => number | string | null; title?: string };

/** Table sorted by a click on a column header (again — the other way), as in CAB and Nihilist. */
export function SortTable<T>({ cols, rows, rowKey, onRow, empty = "Пока пусто.", initial, card }: {
  cols: Col<T>[]; rows: T[]; rowKey: (r: T) => string | number; onRow?: (r: T) => void; empty?: string;
  initial?: { col: string; desc?: boolean };
  /** Phones (and the Telegram MiniApp): rows as cards with a sort menu instead of a wide table. */
  card?: (r: T) => ReactNode;
}) {
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(initial ? { col: initial.col, desc: initial.desc ?? true } : null);
  const col = sort ? cols.find((c) => c.head === sort.col) : undefined;
  const sorted = col?.sort ? [...rows].sort((a, b) => {
    const x = col.sort!(a), y = col.sort!(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ru");
    return sort!.desc ? -c : c;
  }) : rows;
  const sortable = cols.filter((c) => c.sort);
  return (
    <>
    {card && (
      <div className="md:hidden">
        <div className="mb-2 flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Сортировка</span>
          <select value={sort?.col ?? ""} onChange={(e) => setSort(e.target.value ? { col: e.target.value, desc: sort?.desc ?? true } : null)}
            className="flex-1 rounded-full border border-gold/30 bg-black/60 px-3 py-1 text-xs focus:border-gold focus:outline-none">
            {!sort && <option value="">—</option>}
            {sortable.map((c) => <option key={c.head} value={c.head}>{c.head === "#" ? "номер" : c.head.toLowerCase()}</option>)}
          </select>
          <button onClick={() => sort && setSort({ col: sort.col, desc: !sort.desc })}
            className="rounded-full border border-gold/30 px-3 py-1 text-gold">{sort?.desc === false ? "▲ по возрастанию" : "▼ по убыванию"}</button>
        </div>
        <ul className="space-y-2">
          {sorted.map((r) => (
            <li key={rowKey(r)}>
              {onRow ? <button onClick={() => onRow(r)} className="gold-card gold-hover w-full p-3 text-left">{card(r)}</button> : <div className="gold-card p-3">{card(r)}</div>}
            </li>
          ))}
        </ul>
        {rows.length === 0 && <p className="px-2 py-4 text-sm text-muted-foreground">{empty}</p>}
      </div>
    )}
    <div className={`overflow-x-auto ${card ? "hidden md:block" : ""}`}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            {cols.map((c) => (
              <th key={c.head} title={c.title} className="whitespace-nowrap px-2 py-2 font-medium">
                {c.sort ? (
                  <button className={`inline-flex items-center gap-1 uppercase hover:text-gold ${sort?.col === c.head ? "text-gold" : ""}`}
                    onClick={() => setSort(sort?.col === c.head ? { col: c.head, desc: !sort.desc } : { col: c.head, desc: true })}>
                    {c.head}<span className="text-[9px]">{sort?.col === c.head ? (sort.desc ? "▼" : "▲") : "↕"}</span>
                  </button>
                ) : c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={rowKey(r)} onClick={onRow ? () => onRow(r) : undefined}
              className={`border-t border-border/70 ${onRow ? "cursor-pointer hover:bg-gold/5" : ""}`}>
              {cols.map((c) => <td key={c.head} className="whitespace-nowrap px-2 py-1.5 tabular-nums">{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="px-2 py-4 text-sm text-muted-foreground">{empty}</p>}
    </div>
    </>
  );
}
