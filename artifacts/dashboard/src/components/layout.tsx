import { ReactNode } from "react";
import { Radar } from "lucide-react";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground font-mono text-xs overflow-hidden dark">
      <header className="h-12 border-b border-border flex items-center justify-between px-4 bg-card shrink-0">
        <div className="flex items-center gap-2 font-bold text-sm text-primary">
          <Radar size={16} />
          ALT PATTERN SCANNER
        </div>
        <div className="text-muted-foreground">watchlist · 5m cycle · @bitcoinmarginmaster</div>
      </header>
      <main className="flex-1 overflow-y-auto p-2 bg-background min-h-0">
        {children}
      </main>
    </div>
  );
}
