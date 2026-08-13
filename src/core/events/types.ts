export type DomainEvents = {
  "user.registered": { userId: string };

  "post.created": { postId: string; authorId: string };
  "post.approved": { postId: string; authorId: string; moderatorId: string };
  "post.rejected": { postId: string; authorId: string; moderatorId: string };
  "post.liked": { postId: string; authorId: string; likedBy: string };
  "post.unliked": { postId: string; authorId: string; unlikedBy: string };

  "comment.created": { commentId: string; postId: string; authorId: string };

  "sound.played": { soundId: string; userId: string; name: string };

  "stream.online": { title: string | null; game: string | null };
  "stream.offline": Record<string, never>;
};

export type DomainEventName = keyof DomainEvents;

export type DomainEvent<K extends DomainEventName = DomainEventName> = {
  readonly name: K;
  readonly payload: DomainEvents[K];
  readonly occurredAt: Date;
};

export type EventHandler<K extends DomainEventName> = (
  event: DomainEvent<K>,
) => Promise<void> | void;
