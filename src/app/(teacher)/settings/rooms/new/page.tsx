import { PageHeader } from '@/components/layout/page-header';
import { AddRoomFlow } from '@/components/settings/add-room-flow';

export default function NewRoomPage() {
  return (
    <>
      <PageHeader title="Add room" backHref="/settings/rooms" backLabel="Rooms" />
      <AddRoomFlow />
    </>
  );
}
