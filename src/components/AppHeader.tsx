import { Link } from "react-router-dom";

interface Props {
  right?: React.ReactNode;
}

function BrandMark() {
  return (
    <span className="relative flex h-8 w-8 items-center justify-center rounded-md border-2 border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.12)]">
      <span className="absolute left-[7px] top-[6px] h-[14px] w-[12px] rounded-[2px] border-2 border-[hsl(var(--primary))]" />
      <span className="absolute right-[7px] top-[6px] h-[4px] w-[4px] border-r-2 border-t-2 border-[hsl(var(--primary))]" />
      <span className="absolute left-[10px] top-[11px] h-[2px] w-[7px] bg-[hsl(var(--primary))] rounded-full" />
      <span className="absolute left-[10px] top-[15px] h-[2px] w-[7px] bg-[hsl(var(--primary))] rounded-full" />
    </span>
  );
}

export function AppHeader({ right }: Props) {
  return (
    <header className="h-14 flex items-center justify-between px-4 sm:px-5 bg-sidebar border-b border-sidebar-border">
      <Link to="/" className="flex items-center gap-3 min-w-0 group">
        <BrandMark />
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-[1.35rem] font-semibold tracking-tight leading-none">
            <span className="text-brand">Tex</span>Local
          </span>
        </div>
      </Link>
      <div className="flex items-center gap-3">{right}</div>
    </header>
  );
}
