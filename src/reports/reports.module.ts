import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Classroom, ClassroomSchema } from '../classrooms/schemas/classroom.schema';
import { Enrollment, EnrollmentSchema } from '../enrollments/schemas/enrollment.schema';
import { Faculty, FacultySchema } from '../faculties/schemas/faculty.schema';
import { Group, GroupSchema } from '../groups/schemas/group.schema';
import { PeriodsModule } from '../periods/periods.module';
import { Program, ProgramSchema } from '../programs/schemas/program.schema';
import { Student, StudentSchema } from '../students/schemas/student.schema';
import { Subject, SubjectSchema } from '../subjects/schemas/subject.schema';
import { Teacher, TeacherSchema } from '../teachers/schemas/teacher.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Enrollment.name, schema: EnrollmentSchema },
      { name: Group.name, schema: GroupSchema },
      { name: Student.name, schema: StudentSchema },
      { name: Teacher.name, schema: TeacherSchema },
      { name: Program.name, schema: ProgramSchema },
      { name: Subject.name, schema: SubjectSchema },
      { name: Faculty.name, schema: FacultySchema },
      { name: Classroom.name, schema: ClassroomSchema },
      { name: User.name, schema: UserSchema },
    ]),
    PeriodsModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
