import { AsyncLocalStorage } from "async_hooks";

export interface RequestContext {
  userId: string;
  userName: string;
  userRole: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
