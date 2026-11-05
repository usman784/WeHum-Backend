import { Controller, Delete, Get, Param, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CurrentUser, Member, type AppUser } from '../../common/auth';
import { PRIVATE } from '../../common/etag';
import { Zod } from '../../common/zod';
import { FavoritesService } from './favorites.service';

const Id = new Zod(z.string().uuid());

/** Favourite meditations are a membership feature: a free account gets 403 PREMIUM_REQUIRED on every route. */
@ApiTags('Favorites')
@ApiBearerAuth()
@Controller('v1')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Member() @Get('me/favorites')
  list(@CurrentUser() u: AppUser, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', PRIVATE);
    return this.favorites.list(u.id);
  }

  @Member() @Put('sessions/:id/favorite')
  add(@CurrentUser() u: AppUser, @Param('id', Id) id: string) { return this.favorites.set(u.id, id, true); }

  @Member() @Delete('sessions/:id/favorite')
  remove(@CurrentUser() u: AppUser, @Param('id', Id) id: string) { return this.favorites.set(u.id, id, false); }
}
