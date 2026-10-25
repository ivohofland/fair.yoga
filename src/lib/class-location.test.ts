import { describe, it, expect } from 'vitest';
import { classLocation, publicClassLocation, locationLabel, type LocationRow } from './class-location';
import { formatRoomLocation } from './format';

const room = { roomName: 'Studio 2', venueName: 'De Hal' };

const inPerson: LocationRow = {
  format: 'in_person',
  videoUrl: null,
  teacherRoom: { isArchived: true, room },
};

const online: LocationRow = {
  format: 'online',
  videoUrl: 'https://meet.example/abc?pwd=x',
  teacherRoom: null,
};

describe('classLocation', () => {
  it('maps an in-person row to its room and archive state', () => {
    expect(classLocation(inPerson)).toStrictEqual({
      format: 'in_person', room, roomArchived: true,
    });
  });

  it('maps an online row to its link', () => {
    expect(classLocation(online)).toStrictEqual({
      format: 'online', videoUrl: 'https://meet.example/abc?pwd=x',
    });
  });

  it('maps an online row without a link to a null link', () => {
    expect(classLocation({ ...online, videoUrl: null })).toStrictEqual({
      format: 'online', videoUrl: null,
    });
  });

  it('throws on an in-person row with no room (a row the shape CHECK refuses)', () => {
    expect(() => classLocation({ ...inPerson, teacherRoom: null })).toThrow();
  });

  it('throws on an online row that holds a room', () => {
    expect(() => classLocation({ ...online, teacherRoom: { isArchived: false, room } })).toThrow();
  });
});

describe('publicClassLocation', () => {
  it('leaves the link out of an online row entirely', () => {
    expect(publicClassLocation(online)).toStrictEqual({ format: 'online' });
  });

  it('keeps the room of an in-person row but not its archive state', () => {
    expect(publicClassLocation(inPerson)).toStrictEqual({ format: 'in_person', room });
  });

  it('throws on an in-person row with no room', () => {
    expect(() => publicClassLocation({ ...inPerson, teacherRoom: null })).toThrow();
  });
});

describe('locationLabel', () => {
  it('reads "Online" for an online class, public or not', () => {
    expect(locationLabel(classLocation(online))).toBe('Online');
    expect(locationLabel(publicClassLocation(online))).toBe('Online');
  });

  it('reads the room the way formatRoomLocation does', () => {
    expect(locationLabel(classLocation(inPerson))).toBe(formatRoomLocation('Studio 2', 'De Hal'));
    expect(locationLabel(publicClassLocation({
      ...inPerson, teacherRoom: { isArchived: false, room: { roomName: '', venueName: 'De Hal' } },
    }))).toBe('De Hal');
  });
});
