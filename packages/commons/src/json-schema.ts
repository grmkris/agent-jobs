import { Schema } from 'effect'

const McpInputSchema = Schema.Struct({
  type: Schema.Literal('object'),
  properties: Schema.Record(Schema.String, Schema.Unknown),
  required: Schema.Array(Schema.String),
})
export type McpInputSchema = typeof McpInputSchema.Type
export function inputJsonSchema(input: Schema.Constraint): McpInputSchema {
  const document = Schema.toJsonSchemaDocument(input)
  return Schema.decodeUnknownSync(McpInputSchema)({ ...document.schema, required: document.schema.required ?? [] })
}
