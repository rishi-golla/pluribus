import Image from "next/image";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

// the mono wordmark stands in until a logo is picked
export function Brandmark() {
  return (
    <Link href="/" className="text-[19px] font-semibold tracking-[-0.04em]">
      pluribus
    </Link>
  );
}

type ButtonProps = Omit<ComponentProps<typeof Link>, "href"> & { href: string; variant?: "default" | "white" | "ghost"; size?: "md" | "lg" };

export function Button({ variant = "default", size = "md", className, children, ...rest }: ButtonProps) {
  return (
    <Link
      className={cx(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap border font-medium transition-colors",
        size === "md" ? "h-9 px-3.5 text-[13.5px]" : "h-12 px-[22px] text-[15px]",
        variant === "white" && "border-transparent bg-brand text-[#0c0c0c] hover:bg-[#d4ff5e]",
        variant === "default" && "border-line-2 bg-s2 text-t1 hover:bg-s3",
        variant === "ghost" && "border-transparent bg-transparent text-t2 hover:text-t1",
        className,
      )}
      {...rest}
    >
      {children}
    </Link>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[34px] items-center gap-2 whitespace-nowrap border border-line-2 bg-white/[0.015] px-3.5 text-[13px] text-t2 [&_b]:font-medium [&_b]:text-t1">
      {children}
    </span>
  );
}

const tagTones = {
  green: "bg-green-dim text-green",
  orange: "bg-orange-dim text-orange",
  red: "bg-red/12 text-red",
  brand: "bg-brand-dim text-brand",
  neutral: "bg-s3 text-t2",
} as const;

export function Tag({ tone = "neutral", className, children }: { tone?: keyof typeof tagTones; className?: string; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex h-[22px] items-center gap-[5px] whitespace-nowrap px-2 text-[11.5px] font-medium [&_svg]:size-3",
        tagTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusDot() {
  return <span className="inline-block size-1.5 bg-current" />;
}

export function Token({ src, size = 32, className }: { src: string; size?: number; className?: string }) {
  return (
    <span className={cx("relative inline-block shrink-0 rounded-full", className)} style={{ width: size, height: size }}>
      <Image src={src} alt="" width={size} height={size} className="size-full rounded-full object-cover" />
    </span>
  );
}

export function Swatch({ color, className }: { color: string; className?: string }) {
  return <span className={cx("inline-block size-2 shrink-0 ", className)} style={{ background: color }} />;
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("flex items-center gap-[5px] text-[12.5px] text-t3 [&_svg]:size-[13px]", className)}>{children}</div>;
}

export function KV({ k, children, dense = false }: { k: ReactNode; children: ReactNode; dense?: boolean }) {
  return (
    <div className={cx("flex items-center justify-between", dense ? "py-1 text-[13px]" : "py-[7px] text-[13.5px]")}>
      <span className="text-t2">{k}</span>
      <span className="flex items-center gap-1.5 font-medium">{children}</span>
    </div>
  );
}
