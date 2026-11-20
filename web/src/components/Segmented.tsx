"use client";

type SegmentedProps<T extends string> = {
  items: readonly T[];
  value: T;
  onChange: (v: T) => void;
  small?: boolean;
  label: string;
};

export function Segmented<T extends string>({ items, value, onChange, small = false, label }: SegmentedProps<T>) {
  return (
    <div className="flex rounded-lg border border-line bg-bg p-[3px]" role="tablist" aria-label={label}>
      {items.map((it) => {
        const on = it === value;
        return (
          <button
            key={it}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(it)}
            className={`flex-1 cursor-pointer whitespace-nowrap rounded-md text-center font-medium transition-[background-color,color,box-shadow] duration-200 ${
              small ? "px-[9px] py-1 text-xs" : "px-3 py-[7px] text-[13px]"
            } ${on ? "bg-s3 text-t1 shadow-[inset_0_0_0_1px_var(--color-line-2)]" : "text-t3 hover:text-t2"}`}
          >
            {it}
          </button>
        );
      })}
    </div>
  );
}
