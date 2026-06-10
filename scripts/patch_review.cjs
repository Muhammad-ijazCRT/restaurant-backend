const fs = require('fs');
const path = 'e:/Russian Resturent/restaurant-frontend/src/pages/vendor-order-detail.tsx';
let content = fs.readFileSync(path, 'utf8');

// Add Shortage Review UI
const shortageUI = `
  const isManager = currentRole === "vendor_admin" || currentRole === "manager";
  const needsReview = order?.pickingStatus === "review" && isManager;

  const approvePickingMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", \`/api/vendors/\${vendorId}/orders/\${orderId}/approve-picking\`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendors", vendorId, "orders", orderId] });
      toast({ title: "Picking approved", description: "Order is ready for delivery" });
    },
    onError: (err: Error) => {
      toast({ title: "Approval failed", description: err.message, variant: "destructive" });
    }
  });
`;

content = content.replace(
  'const isWarehouseWorker = currentRole === "warehouse" || currentRole === "warehouse_worker" || currentRole === "manager";',
  shortageUI + '\n  const isWarehouseWorker = currentRole === "warehouse" || currentRole === "warehouse_worker" || currentRole === "manager";'
);

const submitButtonReplace = `
            {needsReview && (
              <div className="flex gap-2 mr-auto bg-amber-50 dark:bg-amber-950/30 p-2 rounded-md border border-amber-200 dark:border-amber-800">
                <span className="text-sm text-amber-800 dark:text-amber-200 font-medium my-auto mr-2">Shortage Review needed</span>
                <Button variant="outline" size="sm" onClick={() => pickingMutation.mutate(true)} disabled={pickingMutation.isPending}>Save Edits</Button>
                <Button size="sm" className="bg-amber-600 hover:bg-amber-700" onClick={() => approvePickingMutation.mutate()} disabled={approvePickingMutation.isPending}>Approve Picking</Button>
              </div>
            )}
            {canPick && (
`;

content = content.replace(
  '{canPick && (',
  submitButtonReplace
);

// Allow manager to pick/edit even in review status
content = content.replace(
  'const canPick = order?.status === "submitted" && order?.warehouseWorkerId && isWarehouseWorker;',
  'const canPick = (order?.status === "submitted" && order?.warehouseWorkerId && isWarehouseWorker) || needsReview;'
);

fs.writeFileSync(path, content, 'utf8');
console.log('Patched vendor-order-detail.tsx for shortage review successfully!');
