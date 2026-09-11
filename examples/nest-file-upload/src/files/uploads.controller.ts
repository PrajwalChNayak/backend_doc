import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseFilePipe,
  ParseUUIDPipe,
  Post,
  MaxFileSizeValidator,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { memoryStorage } from 'multer'
import { MagicBytesValidator } from './magic-bytes.validator.js'
import { UploadsService } from './uploads.service.js'

/** 2 MiB. The limit is enforced in two independent places — see the README. */
export const MAX_BYTES = 2 * 1024 * 1024

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      // In-memory, bounded by `fileSize` below, so validation can look at the
      // bytes before anything is written. For large files use diskStorage and
      // delete the file when validation rejects it — see the README.
      storage: memoryStorage(),

      // EVERY limit, not just fileSize. multer's defaults are "unlimited" for
      // most of these, and each unlimited one is its own denial of service.
      limits: {
        fileSize: MAX_BYTES, // bytes per file
        files: 1, // file parts
        fields: 5, // non-file fields
        parts: 6, // files + fields, total
        fieldNameSize: 100, // bytes in a field NAME
        fieldSize: 8 * 1024, // bytes in a non-file field value
        headerPairs: 100, // multipart header pairs
      },

      // A cheap first filter on the CLAIMED type. It is not the real check —
      // the magic-byte validator below is — but it rejects the obvious cases
      // before the body is buffered at all.
      fileFilter: (_req, file, callback) => {
        const claimed = file.mimetype.toLowerCase()
        const plausible = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']
        callback(null, plausible.includes(claimed))
      },
    }),
  )
  async upload(
    @UploadedFile(
      new ParseFilePipe({
        // A missing file is a 400 with a message, not a TypeError later on.
        fileIsRequired: true,
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_BYTES }),
          new MagicBytesValidator({ allow: ['PNG', 'JPEG', 'GIF87a', 'GIF89a', 'WEBP', 'PDF'] }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.uploads.store(file)
  }

  @Get()
  list() {
    return { data: this.uploads.list() }
  }

  @Get('usage')
  usage() {
    return this.uploads.diskUsage()
  }

  @Get(':id')
  metadata(@Param('id', ParseUUIDPipe) id: string) {
    return this.uploads.get(id)
  }
}
