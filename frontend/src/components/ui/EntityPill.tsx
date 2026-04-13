import type { ArticleEntity } from "@/lib/api";

export const ENTITY_STYLES: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  PERSON: { bg: "rgba(167,139,250,0.12)", border: "rgba(167,139,250,0.45)", text: "#c4b5fd", dot: "#a78bfa" },
  ORG:    { bg: "rgba(96,165,250,0.12)",  border: "rgba(96,165,250,0.45)",  text: "#93c5fd", dot: "#60a5fa" },
  GPE:    { bg: "rgba(52,211,153,0.12)",  border: "rgba(52,211,153,0.45)",  text: "#6ee7b7", dot: "#34d399" },
};

/**
 * truncatable — when true the pill text gets `truncate` + a generous max-width so it
 * can shrink to leave room for the "+N" overflow pill next to it. Leave false (default)
 * for full-text pills everywhere else.
 */
export function EntityPill({ entity, truncatable = false }: { entity: ArticleEntity; truncatable?: boolean }) {
  const s = ENTITY_STYLES[entity.label] ?? ENTITY_STYLES.ORG;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium ${truncatable ? "min-w-0" : "shrink-0"}`}
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.text }}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: s.dot }} />
      <span className={truncatable ? "truncate" : ""}>{entity.text}</span>
    </span>
  );
}

export const PERSONAL_TAG_STYLE = {
  bg: "rgba(251,113,133,0.12)",
  border: "rgba(251,113,133,0.45)",
  text: "#fda4af",
  dot: "#fb7185",
};

/** Rose/pink pill for user-trained personal tags */
export function PersonalTagPill({
  name,
  onRemove,
  truncatable = false,
}: {
  name: string;
  onRemove?: () => void;
  truncatable?: boolean;
}) {
  const s = PERSONAL_TAG_STYLE;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium ${truncatable ? "min-w-0" : "shrink-0"}`}
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.text }}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: s.dot }} />
      <span className={truncatable ? "truncate" : ""}>{name}</span>
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 hover:opacity-70 transition-opacity shrink-0"
          style={{ color: s.text }}
          title="Remove tag"
        >
          ×
        </button>
      )}
    </span>
  );
}

export const TOPIC_TAG_STYLE = {
  bg: "rgba(251,191,36,0.12)",
  border: "rgba(251,191,36,0.45)",
  text: "#fde68a",
  dot: "#fbbf24",
};

/** Amber pill for user-defined semantic topic tags */
export function TopicTagPill({
  name,
  truncatable = false,
  onRemove,
}: {
  name: string;
  truncatable?: boolean;
  onRemove?: () => void;
}) {
  const s = TOPIC_TAG_STYLE;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium ${truncatable ? "min-w-0" : "shrink-0"}`}
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.text }}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: s.dot }} />
      <span className={truncatable ? "truncate" : ""}>{name}</span>
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 hover:opacity-70 transition-opacity shrink-0"
          style={{ color: s.text }}
          title="Remove tag"
        >
          ×
        </button>
      )}
    </span>
  );
}

/** Overflow "+N" pill */
export function EntityOverflowPill({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium shrink-0 text-muted"
      style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)" }}>
      +{count}
    </span>
  );
}
