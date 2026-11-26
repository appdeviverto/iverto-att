import { Module } from '@nestjs/common';
import { ProfileRequestsController, ProfileRequestsService } from '../employees/profile-requests';
import { AnnouncementsController, AnnouncementsService } from './announcements';
import { AssetsController, AssetsService } from './assets';
import { ChecklistsController, ChecklistsService } from './checklists';
import { DocumentsController, DocumentsService } from './documents';
import { ExpensesController, ExpensesService } from './expenses';
import { HrSettingsController } from './hr-settings';
import { LettersController, LettersService } from './letters';

@Module({
  controllers: [
    HrSettingsController,
    ChecklistsController,
    DocumentsController,
    LettersController,
    ExpensesController,
    AssetsController,
    AnnouncementsController,
    ProfileRequestsController,
  ],
  providers: [ChecklistsService, DocumentsService, LettersService, ExpensesService, AssetsService, AnnouncementsService, ProfileRequestsService],
  exports: [DocumentsService, ExpensesService, AnnouncementsService, ProfileRequestsService, ChecklistsService, AssetsService],
})
export class HrModule {}
