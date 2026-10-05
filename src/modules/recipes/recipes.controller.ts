import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, Member, type AppUser } from '../../common/auth';
import { Zod } from '../../common/zod';
import { RecipeDto, RecipePatchDto, RecipesService, type RecipeInput } from './recipes.service';

const Id = new Zod(z.string().uuid());
const Slug = new Zod(z.string().regex(/^[a-z0-9-]{3,16}$/));

@ApiTags('Recipes')
@ApiBearerAuth()
@Controller('v1/recipes')
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

  @Member() @Get() list(@CurrentUser() u: AppUser) { return this.recipes.list(u.id); }

  @Member() @HttpCode(201) @Post()
  create(@CurrentUser() u: AppUser, @Body(new Zod(RecipeDto)) b: RecipeInput) { return this.recipes.create(u.id, b); }

  // Anyone with the app can open a shared recipe (playing it needs a membership).
  @Get('shared/:slug') shared(@Param('slug', Slug) slug: string) { return this.recipes.shared(slug); }

  @Member() @Patch(':id')
  update(@CurrentUser() u: AppUser, @Param('id', Id) id: string, @Body(new Zod(RecipePatchDto)) b: Partial<RecipeInput>) { return this.recipes.update(u.id, id, b); }

  @Member() @HttpCode(204) @Delete(':id')
  async remove(@CurrentUser() u: AppUser, @Param('id', Id) id: string) { await this.recipes.remove(u.id, id); }

  @Member() @HttpCode(200) @Post(':id/share')
  share(@CurrentUser() u: AppUser, @Param('id', Id) id: string) { return this.recipes.share(u.id, id); }
}
