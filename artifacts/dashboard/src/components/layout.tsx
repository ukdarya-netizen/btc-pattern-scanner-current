import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Activity, BarChart2, Zap, AlertTriangle, Flame } from "lucide-react";
import { useGetBotState, useGetRiskStats } from "@workspace/api-client-react";

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data: botState } = useGetBotState({ query: { refetchInterval: 2000 } });
  const { data: riskStats } = useGetRiskStats({ query: { refetchInterval: 5000 } });

  const navItems = [
    { href: "/", label: "Terminal", icon: Zap },
    { href: "/risk", label: "Risk & Perf", icon: BarChart2 },
    { href: "/signal", label: "Signal Explorer", icon: Activity },
    { href: "/liquidations", label: "Liquidation Map", icon: Flame },
  ];

  return (
    <div className="flex h-screen bg-background text-foreground font-mono text-xs overflow-hidden dark">
      {/* Sidebar */}
      <div className="w-16 border-r border-border flex flex-col items-center py-4 bg-card shrink-0 z-10">
        <div className="mb-8 font-bold text-primary">SC</div>
        <nav className="flex flex-col gap-6">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href} className={`p-2 rounded hover:bg-accent transition-colors ${location === item.href ? "bg-accent text-primary" : "text-muted-foreground"}`}>
              <item.icon size={20} />
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-4 items-center">
          <div className={`w-3 h-3 rounded-full ${botState?.running ? 'bg-green animate-pulse' : 'bg-muted'}`} />
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="h-12 border-b border-border flex items-center justify-between px-4 bg-card shrink-0">
          <div className="flex items-center gap-4">
            <span className="font-bold text-sm">BTC/USDT</span>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">MODE</span>
              <span className={botState?.mode === 'live' ? 'text-red font-bold' : 'text-primary'}>
                {botState?.mode?.toUpperCase() || 'STOPPED'}
              </span>
            </div>
          </div>
          
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">DAY P&L</span>
              <span className={(riskStats?.dailyPnl ?? 0) >= 0 ? 'text-green' : 'text-red'}>
                ${(riskStats?.dailyPnl ?? 0).toFixed(2)}
              </span>
            </div>
          </div>
        </header>

        {botState?.circuitBreakerTripped && (
          <div className="bg-red/20 text-red px-4 py-2 flex items-center justify-center gap-2 font-bold text-sm shrink-0 border-b border-red/30">
            <AlertTriangle size={16} /> CIRCUIT BREAKER TRIPPED - TRADING HALTED
          </div>
        )}

        <main className="flex-1 overflow-y-auto p-2 bg-background min-h-0">
          {children}
        </main>
      </div>
    </div>
  );
}
