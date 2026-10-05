import { PipeTransform } from '@nestjs/common';
import type { ZodSchema, ZodTypeDef } from 'zod';

/** `@Body(new Zod(schema)) dto: T` — parses + strips unknown keys, throws ZodError → 400 VALIDATION_FAILED. */
export class Zod<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T, ZodTypeDef, unknown>) {}
  transform(value: unknown): T { return this.schema.parse(value ?? {}); }
}
