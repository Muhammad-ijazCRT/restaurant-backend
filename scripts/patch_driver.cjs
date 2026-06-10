const fs = require('fs');
const path = 'e:/Russian Resturent/restaurant-frontend/src/pages/vendor-order-detail.tsx';
let content = fs.readFileSync(path, 'utf8');

// Update mutation to accept note
content = content.replace(
  'const deliverMutation = useMutation({',
  `const [driverNote, setDriverNote] = useState("");
  const deliverMutation = useMutation({`
);

content = content.replace(
  'mutationFn: async () => {',
  'mutationFn: async (note?: string) => {'
);

content = content.replace(
  'const res = await apiRequest("PATCH", `/api/vendors/${vendorId}/orders/${orderId}/deliver`);',
  'const res = await apiRequest("PATCH", `/api/vendors/${vendorId}/orders/${orderId}/deliver`, { note });'
);

// Check if user is driver and update the UI
const driverDeliveryUI = `
  const isDriver = currentRole === "driver" || currentRole === "manager";
  const canDeliver = order?.status === "ready_for_delivery" && isDriver && (order.driverId === currentUserId || !order.driverId);
`;

content = content.replace(
  'const isWarehouseWorker',
  driverDeliveryUI + '\n  const isWarehouseWorker'
);

// Replace "Mark Delivered" button block
const buttonBlock = `
          {canDeliver && (
            <div className="flex flex-col gap-2 items-end">
              <Input
                placeholder="Driver note (optional)..."
                value={driverNote}
                onChange={e => setDriverNote(e.target.value)}
                className="w-[250px] h-8 text-sm"
              />
              <Button
                onClick={() => deliverMutation.mutate(driverNote)}
                disabled={deliverMutation.isPending}
                className="shrink-0"
                data-testid="button-mark-delivered"
              >
                <Truck className="h-4 w-4 mr-1.5" />
                {deliverMutation.isPending ? "Marking…" : "Mark Delivered"}
              </Button>
            </div>
          )}
`;

content = content.replace(
  /\{order\.status === "ready_for_delivery" && \([\s\S]*?\)\}/,
  buttonBlock
);

fs.writeFileSync(path, content, 'utf8');
console.log('Patched vendor-order-detail.tsx for driver notes successfully!');
