/**
 * Eleven accounts spanning every role and membership tier, so each borrowing
 * policy and permission boundary can be exercised without creating accounts by
 * hand first.
 */

import { ROLES, MEMBERSHIP_TYPES, USER_STATUS } from '../../constants/roles.js';

/** One password for every seeded account. Development only. */
export const SEED_PASSWORD = 'Password@123';

export const users = [
  /* --- Staff -------------------------------------------------------- */
  {
    name: 'Meera Krishnan',
    email: 'admin@library.test',
    role: ROLES.ADMIN,
    membershipType: MEMBERSHIP_TYPES.FACULTY,
    phone: '+91 98450 11223',
    _note: 'Full administrator — user management, analytics, audit log',
  },
  {
    name: 'Ravi Menon',
    email: 'librarian@library.test',
    role: ROLES.LIBRARIAN,
    membershipType: MEMBERSHIP_TYPES.FACULTY,
    phone: '+91 98450 33445',
    _note: 'Circulation desk and catalogue management',
  },
  {
    name: 'Fatima Sheikh',
    email: 'librarian2@library.test',
    role: ROLES.LIBRARIAN,
    membershipType: MEMBERSHIP_TYPES.PUBLIC,
    phone: '+91 98450 55667',
    _note: 'Second librarian — useful for testing audit-log attribution',
  },

  /* --- Students ------------------------------------------------------ */
  // 21-day loans, 5 concurrent, 2 renewals.
  {
    name: 'Ananya Sharma',
    email: 'ananya@student.test',
    role: ROLES.MEMBER,
    membershipType: MEMBERSHIP_TYPES.STUDENT,
    phone: '+91 90000 10001',
    studentProfile: {
      enrollmentNo: 'CS2023001',
      department: 'Computer Science',
      course: 'B.Tech',
      year: 3,
      collegeEmail: 'ananya.sharma@college.edu',
      verifiedAt: new Date(),
    },
    _note: 'Verified student — the primary borrowing test account',
  },
  {
    name: 'Rohan Gupta',
    email: 'rohan@student.test',
    role: ROLES.MEMBER,
    membershipType: MEMBERSHIP_TYPES.STUDENT,
    phone: '+91 90000 10002',
    studentProfile: {
      enrollmentNo: 'CS2023002',
      department: 'Computer Science',
      course: 'B.Tech',
      year: 2,
      collegeEmail: 'rohan.gupta@college.edu',
      verifiedAt: new Date(),
    },
    _note: 'Given overdue loans by the seeder, to exercise fines',
  },
  {
    name: 'Priya Nair',
    email: 'priya@student.test',
    role: ROLES.MEMBER,
    membershipType: MEMBERSHIP_TYPES.STUDENT,
    phone: '+91 90000 10003',
    studentProfile: {
      enrollmentNo: 'ME2022014',
      department: 'Mechanical Engineering',
      course: 'B.Tech',
      year: 4,
      collegeEmail: 'priya.nair@college.edu',
    },
    _note: 'Academic details UNVERIFIED — exercises the verify-student flow',
  },
  {
    name: 'Arjun Reddy',
    email: 'arjun@student.test',
    role: ROLES.MEMBER,
    membershipType: MEMBERSHIP_TYPES.STUDENT,
    phone: '+91 90000 10004',
    studentProfile: {
      enrollmentNo: 'PH2021007',
      department: 'Physics',
      course: 'M.Sc',
      year: 2,
      collegeEmail: 'arjun.reddy@college.edu',
      verifiedAt: new Date(),
    },
  },

  /* --- Faculty -------------------------------------------------------- */
  // 30-day loans, 8 concurrent.
  {
    name: 'Dr. Sunita Iyer',
    email: 'sunita@faculty.test',
    role: ROLES.MEMBER,
    membershipType: MEMBERSHIP_TYPES.FACULTY,
    phone: '+91 90000 20001',
    studentProfile: {
      enrollmentNo: 'FAC0042',
      department: 'Computer Science',
      course: 'PhD',
      collegeEmail: 'sunita.iyer@college.edu',
      verifiedAt: new Date(),
    },
    _note: 'Faculty — the most generous borrowing tier',
  },

  /* --- Public members --------------------------------------------------- */
  // 14-day loans, 3 concurrent.
  {
    name: 'Kavita Desai',
    email: 'kavita@public.test',
    role: ROLES.MEMBER,
    membershipType: MEMBERSHIP_TYPES.PUBLIC,
    phone: '+91 90000 30001',
    address: {
      line1: '14 Rose Villa, MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
      country: 'India',
    },
    _note: 'Public member — the most restrictive tier',
  },
  {
    name: 'Imran Qureshi',
    email: 'imran@public.test',
    role: ROLES.MEMBER,
    membershipType: MEMBERSHIP_TYPES.PUBLIC,
    phone: '+91 90000 30002',
    _note: 'Given a large unpaid fine, to exercise the borrowing block',
  },
  {
    name: 'Tara Bose',
    email: 'suspended@public.test',
    role: ROLES.MEMBER,
    membershipType: MEMBERSHIP_TYPES.PUBLIC,
    status: USER_STATUS.SUSPENDED,
    suspensionReason: 'Three items reported lost and unpaid',
    suspendedAt: new Date(),
    _note: 'SUSPENDED — sign-in should be refused with an explanation',
  },
];

export default users;
