import { RailSheet } from "@/components/PlaceAddSheet";
import { Heading } from "@/components/cloud-buy/parts";
import { DoneBotCloudAccess } from "./CloudAccess";

export function DoneBotCloudDialog({ onClose }: { onClose: () => void }) {
  return <RailSheet focusKey="donebot-cloud" onClose={onClose}>
    <div className="flex flex-col gap-5 px-[30px] pb-[26px] pt-7">
      <Heading title="添加云服务" />
      <DoneBotCloudAccess heading={false} />
    </div>
  </RailSheet>;
}
