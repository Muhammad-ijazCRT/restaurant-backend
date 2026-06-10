const fs = require('fs');
const path = 'e:/Russian Resturent/restaurant-frontend/src/pages/vendor-order-detail.tsx';
let content = fs.readFileSync(path, 'utf8');

// Add getUserData to imports
content = content.replace(
  'import { apiRequest, queryClient } from "@/lib/queryClient";',
  'import { apiRequest, queryClient } from "@/lib/queryClient";\nimport { getUserData } from "@/lib/portal-auth";\nimport { Input } from "@/components/ui/input";'
);

// Update VendorOrderDetailResponse interface
content = content.replace(
  '  lineItems: EnrichedLineItem[];',
  '  lineItems: EnrichedLineItem[];\n  fulfillments: any[];'
);

// Add state and picking logic
const stateAdd = `
  const currentUser = getUserData();
  const currentRole = currentUser?.role;
  const currentUserId = currentUser?.id ? String(currentUser.id) : null;
  const isWarehouseWorker = currentRole === "warehouse" || currentRole === "warehouse_worker" || currentRole === "manager";
  const canPick = order?.status === "submitted" && order?.warehouseWorkerId && isWarehouseWorker;

  const [pickingState, setPickingState] = useState<Record<string, { status: string; loadedQty: number; note: string }>>({});

  // Initialize picking state from fulfillments
  if (data?.fulfillments && Object.keys(pickingState).length === 0 && canPick) {
    const initial: any = {};
    for (const li of data.lineItems) {
      const f = data.fulfillments.find((f: any) => f.orderLineItemId === li.id);
      initial[li.id] = {
        status: f?.fulfillmentStatus || "loaded",
        loadedQty: f?.loadedQuantity ?? li.quantity,
        note: f?.warehouseNote || ""
      };
    }
    setPickingState(initial);
  }

  const pickingMutation = useMutation({
    mutationFn: async (submitForReview: boolean) => {
      const items = Object.entries(pickingState).map(([lineItemId, vals]) => ({
        lineItemId,
        ...vals
      }));
      const res = await apiRequest("PATCH", \`/api/vendors/\${vendorId}/orders/\${orderId}/picking\`, { items, submitForReview });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendors", vendorId, "orders", orderId] });
      toast({ title: "Picking updated successfully" });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    }
  });
`;

content = content.replace(
  'const { order, lineItems, restaurantName } = data;',
  stateAdd + '\n  const { order, lineItems, restaurantName, fulfillments } = data;'
);

// Add table headers for picking
content = content.replace(
  '<TableHead className="font-medium text-right">Line Total</TableHead>',
  '<TableHead className="font-medium text-right">Line Total</TableHead>\n                {canPick && (\n                  <>\n                    <TableHead className="font-medium text-right">Picked Qty</TableHead>\n                    <TableHead className="font-medium text-right">Status</TableHead>\n                    <TableHead className="font-medium">Note</TableHead>\n                  </>\n                )}'
);

// Add picking columns
content = content.replace(
  '<TableCell className="text-sm text-right font-semibold" data-testid={`text-item-total-${li.id}`}>\n                      {formatCurrency(String(lineTotal.toFixed(2)))}\n                    </TableCell>',
  '<TableCell className="text-sm text-right font-semibold" data-testid={`text-item-total-\${li.id}`}>\n                      {formatCurrency(String(lineTotal.toFixed(2)))}\n                    </TableCell>\n                    {canPick && (\n                      <>\n                        <TableCell>\n                          <Input type="number" min="0" value={pickingState[li.id]?.loadedQty ?? li.quantity} onChange={e => setPickingState(p => ({...p, [li.id]: {...p[li.id], loadedQty: parseInt(e.target.value) || 0}}))} className="w-20 ml-auto h-8 text-right" />\n                        </TableCell>\n                        <TableCell>\n                          <Select value={pickingState[li.id]?.status ?? "loaded"} onValueChange={v => setPickingState(p => ({...p, [li.id]: {...p[li.id], status: v}}))}>\n                            <SelectTrigger className="w-[110px] h-8 text-sm"><SelectValue /></SelectTrigger>\n                            <SelectContent>\n                              <SelectItem value="loaded">Loaded</SelectItem>\n                              <SelectItem value="partial">Partial</SelectItem>\n                              <SelectItem value="no_stock">No Stock</SelectItem>\n                            </SelectContent>\n                          </Select>\n                        </TableCell>\n                        <TableCell>\n                          <Input placeholder="Note..." value={pickingState[li.id]?.note ?? ""} onChange={e => setPickingState(p => ({...p, [li.id]: {...p[li.id], note: e.target.value}}))} className="w-32 h-8" />\n                        </TableCell>\n                      </>\n                    )}'
);

// Add footer submit buttons for picking
content = content.replace(
  '<div className="px-5 py-3 border-t bg-muted/10 flex justify-end items-center gap-6">',
  `<div className="px-5 py-3 border-t bg-muted/10 flex justify-end items-center gap-6">
            {canPick && (
              <div className="flex gap-2 mr-auto">
                <Button variant="outline" size="sm" onClick={() => pickingMutation.mutate(false)} disabled={pickingMutation.isPending}>Save Progress</Button>
                <Button size="sm" onClick={() => pickingMutation.mutate(true)} disabled={pickingMutation.isPending}>Submit for Review</Button>
              </div>
            )}`
);

fs.writeFileSync(path, content, 'utf8');
console.log('Patched vendor-order-detail.tsx successfully!');
