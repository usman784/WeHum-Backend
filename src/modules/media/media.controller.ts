import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { CurrentUser, type AppUser } from '../../common/auth';
import { Zod } from '../../common/zod';
import { z } from 'zod';
import { MediaService, PlayUrlBody, type PlayUrlRequest } from './media.service';

const PreviewBody = z.object({ sessionId: z.string().uuid() }).strict();

@ApiTags('Media')
@ApiBearerAuth()
@Controller('v1/media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** Premium content → 403 PREMIUM_REQUIRED for non-members. URL valid 6 h (download: 7 d). */
  @HttpCode(200) @Post('play-url')
  playUrl(@CurrentUser() u: AppUser, @Body(new Zod(PlayUrlBody)) b: PlayUrlRequest, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', 'private, no-store');
    return this.media.playUrl(u.id, b);
  }

  /** 30-second preview of a locked premium meditation (free users; members get the full URL). */
  @HttpCode(200) @Post('preview-url')
  preview(@CurrentUser() u: AppUser, @Body(new Zod(PreviewBody)) b: z.infer<typeof PreviewBody>, @Res({ passthrough: true }) res: FastifyReply) {
    res.header('cache-control', 'private, no-store');
    return this.media.previewUrl(u.id, b.sessionId);
  }
}
