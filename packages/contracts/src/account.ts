import { Schema } from "effect";

export const Account = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  currency: Schema.String,
  createdAt: Schema.String,
});
export type Account = Schema.Schema.Type<typeof Account>;
