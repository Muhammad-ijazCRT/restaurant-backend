import { requestContext } from "./async-context";

export interface ActivityActor {
  id: string;
  name: string;
  role: string;
}

export interface ActivityMessageBundle {
  entityName: string;
  metadata: Record<string, unknown>;
}

export function getRequestActor(): ActivityActor {
  const ctx = requestContext.getStore();
  return {
    id: ctx?.userId ?? "system",
    name: ctx?.userName ?? "System",
    role: ctx?.userRole ?? "system",
  };
}

export function withActorMessages(
  actor: ActivityActor,
  selfMessage: string,
  othersMessage: string,
  extra: Record<string, unknown> = {},
): ActivityMessageBundle {
  return {
    entityName: othersMessage,
    metadata: {
      actorId: actor.id,
      actorName: actor.name,
      actorRole: actor.role,
      selfMessage,
      othersMessage,
      ...extra,
    },
  };
}

export function withVendorSelfMessage(
  actor: ActivityActor,
  selfMessage: string,
  othersMessage: string,
  vendorSelfMessage: string,
  extra: Record<string, unknown> = {},
): ActivityMessageBundle {
  const bundle = withActorMessages(actor, selfMessage, othersMessage, extra);
  return {
    entityName: bundle.entityName,
    metadata: {
      ...bundle.metadata,
      vendorSelfMessage,
    },
  };
}
