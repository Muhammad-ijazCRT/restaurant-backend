export function buildActorMetadata(
  actor: { id: string; name: string; role?: string },
  options: {
    selfMessage: string;
    othersMessage: string;
    vendorSelfMessage?: string;
    extra?: Record<string, unknown>;
  },
): Record<string, unknown> {
  return {
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    selfMessage: options.selfMessage,
    othersMessage: options.othersMessage,
    ...(options.vendorSelfMessage ? { vendorSelfMessage: options.vendorSelfMessage } : {}),
    ...options.extra,
  };
}

export function buildLoginMetadata(
  actor: { id: string; name: string; role?: string },
  portalLabel: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return buildActorMetadata(actor, {
    selfMessage: "You logged in successfully",
    othersMessage: `${portalLabel} signed in: ${actor.name}${actor.role ? ` (${actor.role})` : ""}`,
    extra,
  });
}

export function buildProfileUpdateMetadata(
  actor: { id: string; name: string; role?: string },
  portalLabel: string,
): Record<string, unknown> {
  return buildActorMetadata(actor, {
    selfMessage: "You updated your profile",
    othersMessage: `${portalLabel} profile updated: ${actor.name}`,
  });
}

export function buildOrderPlacedMessages(
  restaurant: { id: string; name: string },
  displayId: string | number,
  extra: Record<string, unknown> = {},
): { entityName: string; metadata: Record<string, unknown> } {
  const actor = { id: restaurant.id, name: restaurant.name, role: "restaurant" };
  const metadata = buildActorMetadata(actor, {
    selfMessage: `You placed order #${displayId}`,
    othersMessage: `Order placed: #${displayId} by ${restaurant.name}`,
    extra: { restaurantName: restaurant.name, displayId, ...extra },
  });
  return {
    entityName: metadata.othersMessage as string,
    metadata,
  };
}
