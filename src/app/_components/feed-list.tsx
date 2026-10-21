"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadFeedAction } from "@/app/_actions/feed";
import { PostCard } from "@/app/_components/post-card";
import type { FeedPost } from "@/modules/feed";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";

export function FeedList({
  initialItems,
  initialCursor,
  canInteract,
}: {
  initialItems: FeedPost[];
  initialCursor: string | null;
  canInteract: boolean;
}) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const sentinel = useRef<HTMLDivElement | null>(null);

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return;

    setLoading(true);
    try {
      const page = await loadFeedAction(cursor);

      // Пост мог уехать из ленты между запросами, поэтому склейка идёт
      // по идентификаторам, а не простым конкатенированием.
      setItems((current) => {
        const seen = new Set(current.map((post) => post.id));
        return [...current, ...page.items.filter((post) => !seen.has(post.id))];
      });
      setCursor(page.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [cursor, loading]);

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !cursor) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      // Подгружаем заранее, чтобы лента не дёргалась у самого края.
      { rootMargin: "600px" },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [cursor, loadMore]);

  return (
    <div className="flex flex-col gap-4">
      {items.map((post) => (
        <PostCard key={post.id} post={post} canInteract={canInteract} />
      ))}

      {cursor ? (
        <div ref={sentinel} className="flex justify-center py-6">
          {/* Кнопка — основной путь, наблюдатель за ней лишь улучшение:
              он не срабатывает без отрисовки кадров (фоновая вкладка,
              экономия батареи), да и с клавиатуры лента должна листаться. */}
          <Button
            variant="outline"
            onClick={() => void loadMore()}
            disabled={loading}
          >
            {loading ? <Spinner /> : null}
            {loading ? "Загружаем…" : "Показать ещё"}
          </Button>
        </div>
      ) : items.length > 0 ? (
        <p className="py-6 text-center text-muted-foreground text-sm">
          Это вся лента
        </p>
      ) : null}
    </div>
  );
}
